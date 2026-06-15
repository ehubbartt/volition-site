import * as THREE from 'three';
import { DEFAULT_PACK_FRONT, DEFAULT_PACK_BACK } from '$lib/cards/packs';

// Faithful, reusable IDLE pack/scene factory — a port of the pack-building code
// inlined in PackOpener.svelte (the sculpted bulged foil pack, its physical
// material + foil normal map, the env gradient and the lights), MINUS the
// interaction-only bits (the drag ripple shader and the tear-edge jag). Used by
// PackDisplay3D.svelte so the store's idle 3D packs look identical to the opener's
// (pre-tear) pack. PackOpener keeps its own inline copy for now.

// ── Shared CPU-side textures (procedural; identical for every pack) ─────────
// Created once and reused across all renderer instances. NOT disposed per-instance
// — a three.Texture object can be uploaded into multiple WebGL contexts, and each
// renderer frees its own GPU copy on dispose()/forceContextLoss(); the CPU canvas
// stays valid for the next renderer.
let _foilNormal: THREE.Texture | null = null;
let _envSource: THREE.Texture | null = null;

const FOIL_SIZE = 512;

// Fine foil crinkle as a NORMAL map — tiny facets that catch the glint light as
// sparkle. (Port of PackOpener makeFoilNormal.)
function makeFoilNormal(): THREE.Texture {
	const src = document.createElement('canvas');
	src.width = src.height = FOIL_SIZE;
	const sctx = src.getContext('2d');
	const out = document.createElement('canvas');
	out.width = out.height = FOIL_SIZE;
	const octx = out.getContext('2d');
	const tex = new THREE.CanvasTexture(out);
	tex.wrapS = tex.wrapT = THREE.MirroredRepeatWrapping; // seamless
	tex.repeat.set(3, 4);
	tex.colorSpace = THREE.NoColorSpace;
	if (!sctx || !octx) return tex;
	// layered fine value-noise height field
	sctx.fillStyle = '#808080';
	sctx.fillRect(0, 0, FOIL_SIZE, FOIL_SIZE);
	sctx.imageSmoothingEnabled = true;
	let alpha = 0.55;
	for (const cells of [32, 64, 128, 256]) {
		const o = document.createElement('canvas');
		o.width = o.height = cells;
		const octx2 = o.getContext('2d');
		if (!octx2) continue;
		const id = octx2.createImageData(cells, cells);
		for (let i = 0; i < cells * cells; i++) {
			const v = Math.random() * 255;
			id.data[i * 4] = id.data[i * 4 + 1] = id.data[i * 4 + 2] = v;
			id.data[i * 4 + 3] = 255;
		}
		octx2.putImageData(id, 0, 0);
		sctx.globalAlpha = alpha;
		sctx.drawImage(o, 0, 0, FOIL_SIZE, FOIL_SIZE);
		alpha *= 0.6;
	}
	sctx.globalAlpha = 1;
	// height → normal (Sobel)
	const h = sctx.getImageData(0, 0, FOIL_SIZE, FOIL_SIZE).data;
	const nd = octx.createImageData(FOIL_SIZE, FOIL_SIZE);
	const at = (x: number, y: number) =>
		h[(((y + FOIL_SIZE) % FOIL_SIZE) * FOIL_SIZE + ((x + FOIL_SIZE) % FOIL_SIZE)) * 4];
	const strength = 2.5;
	for (let y = 0; y < FOIL_SIZE; y++) {
		for (let x = 0; x < FOIL_SIZE; x++) {
			const dx = ((at(x - 1, y) - at(x + 1, y)) / 255) * strength;
			const dy = ((at(x, y - 1) - at(x, y + 1)) / 255) * strength;
			const len = Math.hypot(dx, dy, 1);
			const i = (y * FOIL_SIZE + x) * 4;
			nd.data[i] = ((dx / len) * 0.5 + 0.5) * 255;
			nd.data[i + 1] = ((dy / len) * 0.5 + 0.5) * 255;
			nd.data[i + 2] = ((1 / len) * 0.5 + 0.5) * 255;
			nd.data[i + 3] = 255;
		}
	}
	octx.putImageData(nd, 0, 0);
	tex.needsUpdate = true;
	return tex;
}

// A faint, nearly-uniform environment for subtle metallic reflection. (Port of
// PackOpener makeEnvGradient.) Used as the PMREM source per renderer.
function makeEnvSource(): THREE.Texture {
	const c = document.createElement('canvas');
	c.width = 8;
	c.height = 256;
	const ctx = c.getContext('2d');
	const t = new THREE.CanvasTexture(c);
	t.mapping = THREE.EquirectangularReflectionMapping;
	t.colorSpace = THREE.SRGBColorSpace;
	if (!ctx) return t;
	const g = ctx.createLinearGradient(0, 0, 0, 256);
	g.addColorStop(0, '#e6e8ec');
	g.addColorStop(1, '#d4d7dc');
	ctx.fillStyle = g;
	ctx.fillRect(0, 0, 8, 256);
	t.needsUpdate = true;
	return t;
}

function getFoilNormal(): THREE.Texture {
	if (!_foilNormal) _foilNormal = makeFoilNormal();
	return _foilNormal;
}
function getEnvSource(): THREE.Texture {
	if (!_envSource) _envSource = makeEnvSource();
	return _envSource;
}

// ── Per-renderer environment map ───────────────────────────────────────────
// Returns a PMREM env texture for `scene.environment`. The PMREM generator is
// disposed immediately (its output texture stays valid); the caller disposes the
// returned texture on teardown.
export function makePackEnv(renderer: THREE.WebGLRenderer): THREE.Texture {
	const pmrem = new THREE.PMREMGenerator(renderer);
	const envTex = pmrem.fromEquirectangular(getEnvSource()).texture;
	pmrem.dispose();
	return envTex;
}

export function addPackLights(scene: THREE.Scene): void {
	scene.add(new THREE.AmbientLight(0xffffff, 0.95));
	const key = new THREE.DirectionalLight(0xffffff, 1.0);
	key.position.set(3, 5, 6);
	scene.add(key);
	const rim = new THREE.DirectionalLight(0xff9a3c, 0.45);
	rim.position.set(-5, -2, 2);
	scene.add(rim);
	const glint = new THREE.DirectionalLight(0xffffff, 1.3);
	glint.position.set(-4, 4, 5);
	scene.add(glint);
}

// Loads an image's natural aspect (height / width). Falls back to 7/5 (a standard
// pack) if the url and fallback both fail to load.
export function loadPackAspect(url: string | null): Promise<number> {
	return new Promise((resolve) => {
		const probe = (src: string, onFail: () => void) => {
			const img = new Image();
			img.crossOrigin = 'anonymous';
			img.onload = () => resolve((img.naturalHeight || 7) / (img.naturalWidth || 5));
			img.onerror = onFail;
			img.src = src;
		};
		probe(url || DEFAULT_PACK_FRONT, () =>
			url && url !== DEFAULT_PACK_FRONT ? probe(DEFAULT_PACK_FRONT, () => resolve(1.4)) : resolve(1.4)
		);
	});
}

export interface BuildPackOptions {
	frontUrl: string | null;
	backUrl: string | null;
	packW: number;
	packH: number;
	loader: THREE.TextureLoader;
	fullness?: number; // plateau bulge half-thickness (opener uses card-count; ~0.16 = a full pack)
	cardWFrac?: number; // card width as a fraction of the pack (sets the bulge/side seals)
	cardHFrac?: number; // card height fraction
}

// Builds the sealed bulged foil pack as a THREE.Group (front + back sculpted
// planes). Port of PackOpener buildFace/artMat without the tear jag or ripple.
export function buildPackMesh(opts: BuildPackOptions): THREE.Group {
	const {
		frontUrl,
		backUrl,
		packW: W,
		packH: H,
		loader,
		fullness = 0.16,
		cardWFrac = 0.9,
		cardHFrac = 0.82
	} = opts;

	const foilNormal = getFoilNormal();
	const BULGE = fullness;
	const CRUMPLE = 0.002;
	const BULGE_TAPER = 0.04;
	const bBot = 0.5 - cardHFrac / 2;
	const bTop = 0.5 + cardHFrac / 2;
	const bMargin = (1 - cardWFrac) / 2;

	const ss = (a: number, b: number, x: number) => {
		const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
		return t * t * (3 - 2 * t);
	};
	const falloff = (t: number, m: number) => ss(0, m, t) * ss(1, 1 - m, t);
	const wrinkle = (u: number, v: number) =>
		Math.sin(u * 38 + v * 11) * 0.5 +
		Math.sin(u * 17 - v * 29) * 0.35 +
		Math.sin(u * 53 + v * 41) * 0.22 +
		Math.sin(v * 61 + u * 7) * 0.18;

	function artMat(url: string | null, fallback: string) {
		const m = new THREE.MeshPhysicalMaterial({
			roughness: 0.3,
			metalness: 0.1,
			envMapIntensity: 1.45,
			clearcoat: 1.0,
			clearcoatRoughness: 0.07,
			normalMap: foilNormal,
			normalScale: new THREE.Vector2(0.05, 0.05),
			clearcoatNormalMap: foilNormal,
			clearcoatNormalScale: new THREE.Vector2(0.05, 0.05)
		});
		const apply = (t: THREE.Texture) => {
			t.colorSpace = THREE.SRGBColorSpace;
			m.map = t;
			m.needsUpdate = true;
		};
		loader.load(url || fallback, apply, undefined, () => loader.load(fallback, apply));
		return m;
	}

	function buildFace(front: boolean): THREE.Mesh {
		const geo = new THREE.PlaneGeometry(W, H, 52, 56);
		const pos = geo.attributes.position;
		const uv = geo.attributes.uv;
		for (let i = 0; i < pos.count; i++) {
			const x = pos.getX(i);
			const yl = pos.getY(i);
			const u = (x + W / 2) / W;
			const v = (yl + H / 2) / H;
			const vBand = ss(bBot - BULGE_TAPER, bBot, v) * ss(bTop + BULGE_TAPER, bTop, v);
			const plateau = BULGE * falloff(u, bMargin) * vBand;
			const cr =
				CRUMPLE *
				wrinkle(front ? u : u + 1.7, front ? v : v + 2.3) *
				falloff(u, 0.05) *
				falloff(v, 0.05);
			pos.setZ(i, (front ? plateau : -plateau) + cr);
			uv.setXY(i, front ? u : 1 - u, v);
		}
		pos.needsUpdate = true;
		uv.needsUpdate = true;
		geo.computeVertexNormals();
		const mat = artMat(front ? frontUrl : backUrl, front ? DEFAULT_PACK_FRONT : DEFAULT_PACK_BACK);
		if (!front) mat.side = THREE.BackSide;
		return new THREE.Mesh(geo, mat);
	}

	const group = new THREE.Group();
	group.add(buildFace(true));
	group.add(buildFace(false));
	return group;
}

// Distance the camera so the pack fills ~`fracH` of the view height and ~`fracW`
// of the width (port of PackOpener's resize fit, re-expressed as fill fractions).
export function fitPackCamera(
	camera: THREE.PerspectiveCamera,
	w: number,
	h: number,
	packW: number,
	packH: number,
	fracH = 0.72,
	fracW = 0.86
): void {
	camera.aspect = w / h;
	const vfov = (camera.fov * Math.PI) / 180;
	const viewH = packH / fracH;
	const viewW = packW / fracW;
	const distV = viewH / 2 / Math.tan(vfov / 2);
	const distH = viewW / 2 / (Math.tan(vfov / 2) * camera.aspect);
	camera.position.z = Math.max(distV, distH);
	camera.updateProjectionMatrix();
}
