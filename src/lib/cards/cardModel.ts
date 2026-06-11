// CLIENT three: load a card's optional Blender .glb model and place it hovering above
// the card art in the 3D views (CardInspector3D + PackOpener). Mirrors the
// layerTexture.ts handle contract (update/dispose) so both renderers use it the same way.
//
// GLTFLoader is lazy-imported (dynamic import) so the ~150KB loader only loads for cards
// that actually have a model — and never lands in the SSR/server bundle. three 0.184
// ships it at three/examples/jsm/loaders (there is no three/addons in this version).

import * as THREE from 'three';
import type { CardModelSettings, ModelFrontAxis } from './rarity';

// Re-exported so existing importers (e.g. CardModelBuilder) can keep importing it here.
export type { CardModelSettings } from './rarity';

// Local-space unit vector for each "front axis" choice — the model's nose.
const FRONT_VECS: Record<ModelFrontAxis, [number, number, number]> = {
	'+x': [1, 0, 0],
	'-x': [-1, 0, 0],
	'+y': [0, 1, 0],
	'-y': [0, -1, 0],
	'+z': [0, 0, 1],
	'-z': [0, 0, -1]
};

export interface CardModelHandle {
	// The placed model group — exposed so the builder can attach a gizmo + read transforms.
	object: THREE.Object3D | null;
	// Base auto-fit scale; final scale = autofitScale * settings.scale. 0 on a failed load.
	autofitScale: number;
	// Re-apply settings live (position/rotation/scale/clip/animate) — used by the builder.
	setSettings: (s: CardModelSettings) => void;
	// dt = seconds since last frame; `drag` = the card's drag/tilt speed (unused for
	// tilt-only models, accepted for parity with the layer-effect update signature).
	update: (dt: number, drag: number) => void;
	dispose: () => void;
}

// Returned when loading fails — keeps the flat card rendering (graceful degradation).
const NOOP: CardModelHandle = {
	object: null,
	autofitScale: 0,
	setSettings: () => {},
	update: () => {},
	dispose: () => {}
};

const deg2rad = (d: number) => (d * Math.PI) / 180;

// Card-local z of the clip boundary = the card's front surface. With `clip`, the model
// is embedded straddling this plane and everything behind it (into/through the card) is
// cut away, so nothing pokes out the back.
const FACE_CLIP_Z = 0;

// Reused per-frame scratch (no allocation in the render loop). Shared across handles —
// safe because each handle's update() runs synchronously to completion.
const _n = new THREE.Vector3();
const _p = new THREE.Vector3();
const _pq = new THREE.Quaternion();
const _cq = new THREE.Quaternion();
const _rf = new THREE.Quaternion();
const _q = new THREE.Quaternion();
const _qy = new THREE.Quaternion();
const _zAxis = new THREE.Vector3(0, 0, 1);
const _euler = new THREE.Euler();
const _v = new THREE.Vector3();

// Dispose a material and any textures it references (map, normalMap, …).
function disposeMaterial(mat: THREE.Material) {
	for (const v of Object.values(mat as unknown as Record<string, unknown>)) {
		const tex = v as THREE.Texture | null;
		if (tex && tex.isTexture) tex.dispose();
	}
	mat.dispose();
}

// Load `url` and attach it (hovering at `baseZ`, auto-fit to ~70% of the card width) as
// a child of `parent` (a card Group/mesh) so it inherits the card's tilt/flip. Returns a
// handle to update (animation/spin) each frame and dispose on teardown.
export async function loadCardModel(
	parent: THREE.Object3D,
	url: string,
	settings: CardModelSettings,
	opts: { cardW: number; cardH: number; baseZ: number; camera?: THREE.Camera | null }
): Promise<CardModelHandle> {
	let GLTFLoaderCtor: typeof import('three/examples/jsm/loaders/GLTFLoader.js').GLTFLoader;
	try {
		({ GLTFLoader: GLTFLoaderCtor } = await import('three/examples/jsm/loaders/GLTFLoader.js'));
	} catch (e) {
		console.error('[cardModel] GLTFLoader import failed:', e instanceof Error ? e.message : e);
		return NOOP;
	}

	let gltf;
	try {
		gltf = await new GLTFLoaderCtor().loadAsync(url);
	} catch (e) {
		// Draco-compressed or malformed GLBs land here — leave the flat card as-is.
		console.error('[cardModel] load failed:', e instanceof Error ? e.message : e);
		return NOOP;
	}

	const root = gltf.scene;

	// Auto-fit: recenter the model's bounding box to its local origin, then scale so its
	// largest X/Y span fills ~70% of the card width.
	const box = new THREE.Box3().setFromObject(root);
	const size = box.getSize(new THREE.Vector3());
	const center = box.getCenter(new THREE.Vector3());
	root.position.sub(center);
	const span = Math.max(size.x, size.y, 1e-3);
	const autofitScale = (opts.cardW * 0.7) / span;

	// Wrapper group carries our placement/scale so the AnimationMixer (which animates
	// nodes INSIDE root) isn't fought by the transforms we apply.
	const wrapper = new THREE.Group();
	wrapper.add(root);
	parent.add(wrapper);

	// Every material in the model (for live clip on/off).
	const materials: THREE.Material[] = [];
	root.traverse((o) => {
		const m = (o as THREE.Mesh).material;
		if (!m) return;
		for (const mat of Array.isArray(m) ? m : [m]) if (!materials.includes(mat)) materials.push(mat);
	});

	// Clip plane (world space), re-derived each frame from the card's front face so it
	// tracks the card as it tilts/flips. Geometry behind the face is cut away.
	const clipPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);

	let mixer: THREE.AnimationMixer | null = null;
	if (gltf.animations.length) {
		mixer = new THREE.AnimationMixer(root);
		for (const clipAnim of gltf.animations) mixer.clipAction(clipAnim).play();
	}

	const camera = opts.camera ?? null;
	let cur: CardModelSettings = {};
	// The model's local "front" axis (its nose), for faceCamera + wander facing.
	const frontVec = new THREE.Vector3(0, 0, 1);
	// Base orientation (rotX/Y/Z) as a quaternion + the angle (in the card plane) the
	// base-rotated front points. Wander keeps qBase and only YAWS about the card normal
	// to face travel, so a model tilted flat (e.g. a spider) stays flat as it turns.
	const qBase = new THREE.Quaternion();
	let baseFrontAngle = 0;
	// Wander roam bounds (within the card face) + current target.
	const wanderBX = opts.cardW * 0.38;
	const wanderBY = opts.cardH * 0.38;
	let wanderTarget: THREE.Vector3 | null = null;
	const pickTarget = () =>
		new THREE.Vector3((Math.random() * 2 - 1) * wanderBX, (Math.random() * 2 - 1) * wanderBY, 0);

	// (Re)apply all placement settings — called at load AND live by the builder.
	const setSettings = (s: CardModelSettings) => {
		cur = { ...s };
		frontVec.set(...(FRONT_VECS[s.frontAxis ?? '+z'] ?? FRONT_VECS['+z']));
		wrapper.scale.setScalar(autofitScale * (s.scale ?? 1));
		wrapper.position.set(s.offsetX ?? 0, s.offsetY ?? 0, s.offsetZ ?? (s.clip ? FACE_CLIP_Z : opts.baseZ));
		// Base orientation from the rot knobs (used directly when static; as the base that
		// wander yaws on top of). Also record where the base-rotated front points in-plane.
		_euler.set(deg2rad(s.rotX ?? 0), deg2rad(s.rotY ?? 0), deg2rad(s.rotZ ?? 0));
		qBase.setFromEuler(_euler);
		_v.copy(frontVec).applyQuaternion(qBase);
		baseFrontAngle = Math.atan2(_v.y, _v.x);
		// Billboard / wander drive rotation each frame, so only set the base otherwise.
		if (!s.faceCamera && !s.wander) wrapper.quaternion.copy(qBase);
		for (const mat of materials) {
			mat.clippingPlanes = s.clip ? [clipPlane] : [];
			mat.clipShadows = !!s.clip;
		}
		if (mixer) mixer.timeScale = s.animate === false ? 0 : 1;
	};
	setSettings(settings);

	return {
		object: wrapper,
		autofitScale,
		setSettings,
		update: (dt) => {
			mixer?.update(dt);

			if (cur.wander) {
				// Roam toward a random point within the card bounds; on arrival pick a new
				// one. Keep the base orientation (qBase) and only YAW about the card normal
				// to point the (base-rotated) front along the travel direction — so a model
				// laid flat stays flat as it turns.
				if (!wanderTarget) wanderTarget = pickTarget();
				const dx = wanderTarget.x - wrapper.position.x;
				const dy = wanderTarget.y - wrapper.position.y;
				const d = Math.hypot(dx, dy);
				if (d < 0.04) {
					wanderTarget = pickTarget();
				} else {
					const step = Math.min(d, (cur.wanderSpeed ?? 0.5) * dt);
					wrapper.position.x += (dx / d) * step;
					wrapper.position.y += (dy / d) * step;
					_qy.setFromAxisAngle(_zAxis, Math.atan2(dy, dx) - baseFrontAngle);
					wrapper.quaternion.copy(_qy).multiply(qBase);
				}
			} else if (cur.faceCamera && camera) {
				// Billboard: point the front axis at the camera. World target Q = cameraWorld
				// · (frontVec→+Z); wrapperLocal = parentWorld⁻¹ · Q.
				parent.getWorldQuaternion(_pq);
				camera.getWorldQuaternion(_cq);
				_rf.setFromUnitVectors(frontVec, _zAxis);
				_q.copy(_cq).multiply(_rf);
				wrapper.quaternion.copy(_pq.invert()).multiply(_q);
			} else if (cur.spin) {
				wrapper.rotation.y += cur.spin * dt;
			}

			// Keep the clip plane glued to the card's front face (in world space).
			if (cur.clip) {
				parent.updateWorldMatrix(true, false);
				_n.set(0, 0, 1).applyQuaternion(parent.getWorldQuaternion(_pq)).normalize();
				_p.set(0, 0, FACE_CLIP_Z).applyMatrix4(parent.matrixWorld);
				clipPlane.setFromNormalAndCoplanarPoint(_n, _p);
			}
		},
		dispose: () => {
			mixer?.stopAllAction();
			mixer = null;
			wrapper.traverse((obj) => {
				const mesh = obj as THREE.Mesh;
				if (mesh.geometry) mesh.geometry.dispose();
				const m = mesh.material;
				if (m) {
					if (Array.isArray(m)) m.forEach(disposeMaterial);
					else disposeMaterial(m);
				}
			});
			parent.remove(wrapper);
		}
	};
}
