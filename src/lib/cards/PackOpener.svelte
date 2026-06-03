<script lang="ts">
	import { onMount } from 'svelte';
	import * as THREE from 'three';
	import { TessellateModifier } from 'three/examples/jsm/modifiers/TessellateModifier.js';
	import { DEFAULT_CARD_BACK, RARITY_BY_KEY, type Card } from '$lib/cards/rarity';
	import { DEFAULT_PACK_FRONT, DEFAULT_PACK_BACK } from '$lib/cards/packs';

	interface OpenerPack {
		name: string;
		front_url: string | null;
		back_url: string | null;
	}

	// Four holo tiers, applied progressively (card 1 → tier 1, etc., then cycling)
	// so each look can be compared. Each tier has its own pattern; `holo` = rainbow
	// strength, `sheen` = moving glare. Kept subtle on purpose.
	const HOLO_LEVELS = [
		{ label: 'Holo I · Stripe', holo: 0.06, sheen: 0.04, pattern: 0 },
		{ label: 'Holo II · Sparkle', holo: 0.1, sheen: 0.05, pattern: 1 },
		{ label: 'Holo III · Wave', holo: 0.14, sheen: 0.06, pattern: 2 },
		{ label: 'Holo IV · Prism', holo: 0.2, sheen: 0.08, pattern: 3 }
	];

	const HOLO_VERT = `
		varying vec2 vUv;
		varying vec3 vNormal;
		varying vec3 vViewPos;
		void main() {
			vUv = uv;
			vec4 mv = modelViewMatrix * vec4(position, 1.0);
			vViewPos = -mv.xyz;
			vNormal = normalMatrix * normal;
			gl_Position = projectionMatrix * mv;
		}
	`;

	const HOLO_FRAG = `
		uniform sampler2D map;
		uniform float uHolo;
		uniform float uSheen;
		uniform float uOpacity;
		uniform int uPattern;
		varying vec2 vUv;
		varying vec3 vNormal;
		varying vec3 vViewPos;
		void main() {
			vec4 base = texture2D(map, vUv);
			vec3 N = normalize(vNormal);
			vec3 V = normalize(vViewPos);
			float fres = pow(1.0 - clamp(dot(N, V), 0.0, 1.0), 3.0);

			// All motion is driven by how the card is tilted toward the viewer
			// (N.xy is ~0 facing the camera and grows as it rotates) — no time,
			// so the holo only shifts as you move the card.
			vec2 tilt = N.xy;
			float flow = (tilt.x + tilt.y) * 9.0;

			vec2 p = vUv;
			float phase;  // drives the rainbow hue
			float glare;  // bright reflective mask

			if (uPattern == 0) {
				// diagonal stripes
				phase = (p.x + p.y) * 5.0 + flow;
				glare = smoothstep(0.6, 1.0, sin((p.x + p.y) * 7.0 + flow * 1.4 + fres * 3.0));
			} else if (uPattern == 1) {
				// sparkle dot grid
				vec2 cell = fract(p * 9.0) - 0.5;
				float d = length(cell);
				float tw = 0.5 + 0.5 * sin(flow * 1.5 + (floor(p.x * 9.0) + floor(p.y * 9.0)) * 1.7);
				phase = p.x * 5.0 - p.y * 5.0 + flow;
				glare = smoothstep(0.32, 0.0, d) * tw;
			} else if (uPattern == 2) {
				// radial interference waves
				float r = length(p - 0.5);
				phase = r * 9.0 + flow;
				glare = smoothstep(0.6, 1.0, sin(r * 34.0 + flow * 2.0 + fres * 4.0));
			} else {
				// prismatic swirl
				vec2 c = p - 0.5;
				float a = atan(c.y, c.x);
				float r = length(c);
				phase = a * 1.5 + r * 4.0 + flow;
				glare = smoothstep(0.6, 1.0, sin(a * 8.0 + flow + r * 10.0));
			}

			vec3 rainbow = 0.5 + 0.5 * cos(6.28318 * (vec3(0.0, 0.33, 0.67) + phase + fres * 3.0));
			vec3 col = base.rgb;
			col += rainbow * uHolo * (0.3 + fres) * base.a;
			// shine is mostly rainbow-tinted, only a hint of white so it doesn't wash out the color
			col += mix(rainbow, vec3(1.0), 0.25) * glare * uSheen * base.a;
			gl_FragColor = vec4(col, base.a * uOpacity);
		}
	`;

	// Extra floating holo sheet for the top tier — a translucent prismatic layer
	// that drifts in front of the card (additive) for a layered-depth shimmer.
	const HOLO_OVERLAY_FRAG = `
		uniform float uOpacity;
		varying vec2 vUv;
		varying vec3 vNormal;
		varying vec3 vViewPos;
		void main() {
			vec3 N = normalize(vNormal);
			vec3 V = normalize(vViewPos);
			float fres = pow(1.0 - clamp(dot(N, V), 0.0, 1.0), 2.0);
			vec2 tilt = N.xy;
			float flow = (tilt.x + tilt.y) * 9.0;
			// shift the overlay pattern with tilt for a floating parallax
			vec2 p = vUv + tilt * 0.18;
			vec2 c = p - 0.5;
			float a = atan(c.y, c.x);
			float r = length(c);
			float band = sin(a * 10.0 + flow + r * 14.0);
			float mask = smoothstep(0.45, 1.0, band) * (0.25 + fres);
			vec3 rainbow = 0.5 + 0.5 * cos(6.28318 * (vec3(0.0, 0.33, 0.67) + a + flow * 0.3));
			gl_FragColor = vec4(rainbow * mask, mask * uOpacity * 0.7);
		}
	`;


	let {
		pack,
		cards,
		onClose
	}: { pack: OpenerPack; cards: Card[]; onClose: () => void } = $props();

	let canvas: HTMLCanvasElement;
	let stage = $state<'pack' | 'cards'>('pack');
	let locked = $state(true); // rotation lock (default on) so tearing is easy
	let ripping = $state(false); // true once a tear has begun (hides the tip)
	let currentIndex = $state(0);
	let total = $derived(cards.length);
	let holoLabels = $state<string[]>([]);

	let currentCard = $derived(cards[Math.min(currentIndex, total - 1)] ?? null);
	let currentRarity = $derived(
		currentCard ? (RARITY_BY_KEY[currentCard.rarity] ?? RARITY_BY_KEY.common) : null
	);
	let currentHolo = $derived(holoLabels[currentIndex] ?? '');

	// Imperative bridges so the DOM HUD can drive the 3D scene.
	let goTo: (i: number) => void = () => {};
	let triggerRip: () => void = () => {};

	onMount(() => {
		const PACK_W = 3,
			PACK_H = 4.3,
			PACK_D = 0.14,
			CORNER = 0.2; // rounded-corner radius
		const TEAR_BASE = 0.8; // uv height of the tear line
		const RIP_DISTANCE = 650; // px of horizontal swipe to fully rip
		const tearWorldY = (TEAR_BASE - 0.5) * PACK_H;

		const scene = new THREE.Scene();
		const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 100);
		camera.position.set(0, 0, 8);

		const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
		renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

		scene.add(new THREE.AmbientLight(0xffffff, 0.9));
		const key = new THREE.DirectionalLight(0xffffff, 1.1);
		key.position.set(3, 5, 6);
		scene.add(key);
		const rim = new THREE.DirectionalLight(0xff9a3c, 0.5);
		rim.position.set(-5, -2, 2);
		scene.add(rim);

		const loader = new THREE.TextureLoader();
		loader.crossOrigin = 'anonymous';

		// ---- Solid extruded pack, split into body + lid along a jagged seam ----
		const W = PACK_W,
			H = PACK_H,
			r = CORNER;
		const tearY = tearWorldY; // centered-coords height of the tear

		// deterministic jagged tear profile across the width (flat at the ends)
		const N = 16,
			JAG = 0.1;
		const jag: number[] = [];
		for (let i = 0; i <= N; i++) {
			if (i === 0 || i === N) {
				jag.push(0);
				continue;
			}
			const f = Math.sin(i * 127.1) * 43758.5453;
			jag.push((f - Math.floor(f) - 0.5) * 2 * JAG);
		}
		const jagX = (i: number) => -W / 2 + (i / N) * W;

		function bodyShape() {
			const s = new THREE.Shape();
			s.moveTo(-W / 2 + r, -H / 2);
			s.lineTo(W / 2 - r, -H / 2);
			s.quadraticCurveTo(W / 2, -H / 2, W / 2, -H / 2 + r);
			s.lineTo(W / 2, tearY);
			for (let i = N - 1; i >= 0; i--) s.lineTo(jagX(i), tearY + jag[i]);
			s.lineTo(-W / 2, -H / 2 + r);
			s.quadraticCurveTo(-W / 2, -H / 2, -W / 2 + r, -H / 2);
			return s;
		}
		function lidShape() {
			const s = new THREE.Shape();
			s.moveTo(-W / 2, tearY);
			for (let i = 1; i <= N; i++) s.lineTo(jagX(i), tearY + jag[i]);
			s.lineTo(W / 2, H / 2 - r);
			s.quadraticCurveTo(W / 2, H / 2, W / 2 - r, H / 2);
			s.lineTo(-W / 2 + r, H / 2);
			s.quadraticCurveTo(-W / 2, H / 2, -W / 2, H / 2 - r);
			s.lineTo(-W / 2, tearY);
			return s;
		}

		function remapUV(geo: THREE.BufferGeometry, flipX = false) {
			const pos = geo.attributes.position,
				uv = geo.attributes.uv;
			for (let i = 0; i < pos.count; i++) {
				let u = (pos.getX(i) + W / 2) / W;
				if (flipX) u = 1 - u;
				uv.setXY(i, u, (pos.getY(i) + H / 2) / H);
			}
			uv.needsUpdate = true;
			return geo;
		}

		const darkMat = () =>
			new THREE.MeshStandardMaterial({ color: 0x0e0b07, roughness: 0.85, metalness: 0.05 });
		function artMat(url: string | null, fallback: string) {
			const m = new THREE.MeshStandardMaterial({ roughness: 0.6, metalness: 0.05 });
			const apply = (t: THREE.Texture) => {
				t.colorSpace = THREE.SRGBColorSpace;
				m.map = t;
				m.needsUpdate = true;
			};
			loader.load(url || fallback, apply, undefined, () => loader.load(fallback, apply));
			return m;
		}

		// A solid extruded half with BEVELED (rounded) edges. The art is inset to
		// the flat part of the face so the rounded dark edge wraps around it.
		const BEVEL_T = 0.03, // bevel depth along z
			BEVEL_S = 0.04; // bevel inset in x/y

		// Progressive peel: a vertex-shader fold that curls the lid up about the
		// tear line, with the crease sweeping left→right as uRip grows — so the
		// top rips across gradually instead of detaching all at once.
		const PEEL_W = 1.0, // width of the tear crease band
			LIFT_BASE = 0.9, // how far the torn strip lifts as the crease passes
			LIFT_RIP = 2.8, // extra lift as the rip finishes (strip flies away)
			ZAWAY = 0.55, // how far the torn strip pulls off the pack (away from body)
			CURL_OUT = 0.3; // slight outward curl along the strip
		const gf = (n: number) => n.toFixed(4);
		const peelUniforms: { value: number }[] = [];
		// face = +1 for the front sheet, -1 for the back sheet, so each peels AWAY
		// from the solid body on its own side (never rotating into it).
		function makePeelable<T extends THREE.Material>(mat: T, face: number): T {
			mat.onBeforeCompile = (shader) => {
				shader.uniforms.uRip = { value: 0 };
				shader.vertexShader =
					'uniform float uRip;\n' +
					shader.vertexShader.replace(
						'#include <begin_vertex>',
						`#include <begin_vertex>
						float tf = mix(${gf(-W / 2)}, ${gf(W / 2)}, uRip);
						float torn = 1.0 - smoothstep(tf - ${gf(PEEL_W)}, tf, transformed.x);
						float lift = smoothstep(0.0, 0.35, torn);
						float dyy = transformed.y - ${gf(tearWorldY)};
						// rise + fly away, and pull off the pack on this sheet's side
						transformed.y += lift * (${gf(LIFT_BASE)} + uRip * ${gf(LIFT_RIP)});
						transformed.z += ${gf(face)} * (lift * ${gf(ZAWAY)} + dyy * lift * ${gf(CURL_OUT)});`
					);
				peelUniforms.push(shader.uniforms.uRip as { value: number });
			};
			mat.customProgramCacheKey = () =>
				'peel-' + (face > 0 ? 'f' : 'b') + ('map' in mat && (mat as { map?: unknown }).map ? 'm' : 'p');
			return mat;
		}

		// Peeling geometry must be finely subdivided or the bend stretches the art.
		function tessellate(geo: THREE.BufferGeometry) {
			const ni = geo.index ? geo.toNonIndexed() : geo;
			return new TessellateModifier(0.12, 6).modify(ni);
		}

		const packGroup = new THREE.Group();
		packGroup.rotation.set(-0.05, 0, 0);
		scene.add(packGroup);

		// BODY: solid slab below the tear (rounded edges, jagged rounded top edge).
		// Nothing above the tear, so peeling the lid reveals an actual opening
		// rather than leaving a slab behind.
		const bodyExtrude = new THREE.ExtrudeGeometry(bodyShape(), {
			depth: Math.max(0.01, PACK_D - 2 * BEVEL_T),
			bevelEnabled: true,
			bevelThickness: BEVEL_T,
			bevelSize: BEVEL_S,
			bevelSegments: 4,
			curveSegments: 12
		});
		bodyExtrude.computeBoundingBox();
		const bbb = bodyExtrude.boundingBox!;
		const halfD = (bbb.max.z - bbb.min.z) / 2;
		bodyExtrude.translate(0, 0, -(bbb.min.z + bbb.max.z) / 2);

		const bodyGroup = new THREE.Group();
		bodyGroup.add(new THREE.Mesh(bodyExtrude, darkMat()));
		const bodyFront = new THREE.Mesh(
			remapUV(new THREE.ShapeGeometry(bodyShape(), 22)),
			artMat(pack.front_url, DEFAULT_PACK_FRONT)
		);
		bodyFront.position.z = halfD + 0.003;
		bodyGroup.add(bodyFront);
		const bodyBackMat = artMat(pack.back_url, DEFAULT_PACK_BACK);
		bodyBackMat.side = THREE.BackSide;
		const bodyBack = new THREE.Mesh(
			remapUV(new THREE.ShapeGeometry(bodyShape(), 22), true),
			bodyBackMat
		);
		bodyBack.position.z = -halfD - 0.003;
		bodyGroup.add(bodyBack);
		packGroup.add(bodyGroup);

		// LID: thin peelable sheet of the top region (no core → bends cleanly),
		// sitting just above the body's dark top so it peels off to reveal it.
		const lidGroup = new THREE.Group();
		const lidFront = new THREE.Mesh(
			tessellate(remapUV(new THREE.ShapeGeometry(lidShape(), 22))),
			makePeelable(artMat(pack.front_url, DEFAULT_PACK_FRONT), 1)
		);
		lidFront.position.z = halfD + 0.006;
		lidGroup.add(lidFront);
		const lidBackMat = makePeelable(artMat(pack.back_url, DEFAULT_PACK_BACK), -1);
		lidBackMat.side = THREE.BackSide;
		const lidBack = new THREE.Mesh(
			tessellate(remapUV(new THREE.ShapeGeometry(lidShape(), 22), true)),
			lidBackMat
		);
		lidBack.position.z = -halfD - 0.006;
		lidGroup.add(lidBack);
		packGroup.add(lidGroup);

		// ---- Cards (planes with the holo shader) ----
		function makeCardMat(url: string | null, fallback: string, level: (typeof HOLO_LEVELS)[number]) {
			const mat = new THREE.ShaderMaterial({
				uniforms: {
					map: { value: null },
					uHolo: { value: level.holo },
					uSheen: { value: level.sheen },
					uPattern: { value: level.pattern },
					uOpacity: { value: 0 }
				},
				vertexShader: HOLO_VERT,
				fragmentShader: HOLO_FRAG,
				transparent: true
			});
			const apply = (t: THREE.Texture) => {
				t.colorSpace = THREE.SRGBColorSpace;
				mat.uniforms.map.value = t;
				mat.needsUpdate = true;
			};
			loader.load(url || fallback, apply, undefined, () => loader.load(fallback, apply));
			return mat;
		}

		const CARD_W = 2.7,
			CARD_H = CARD_W * (7 / 5);
		const cardGeo = new THREE.PlaneGeometry(CARD_W, CARD_H);
		const labels: string[] = [];
		const overlayMats: (THREE.ShaderMaterial | null)[] = [];
		const cardMeshes: THREE.Mesh[] = cards.map((c, i) => {
			// Progressive: card 1 → tier 1, 2 → tier 2, … then cycle.
			const level = HOLO_LEVELS[i % HOLO_LEVELS.length];
			labels.push(level.label);
			const m = new THREE.Mesh(cardGeo, makeCardMat(c.front_url, DEFAULT_CARD_BACK, level));
			m.visible = false;
			m.position.set(0, -1.5, 0);

			// Top tier gets a second, floating holo sheet in front of the card.
			if (level.pattern === HOLO_LEVELS.length - 1) {
				const ovMat = new THREE.ShaderMaterial({
					uniforms: { uOpacity: { value: 0 } },
					vertexShader: HOLO_VERT,
					fragmentShader: HOLO_OVERLAY_FRAG,
					transparent: true,
					depthWrite: false,
					blending: THREE.AdditiveBlending
				});
				const ov = new THREE.Mesh(cardGeo, ovMat);
				ov.position.z = 0.08;
				m.add(ov);
				overlayMats.push(ovMat);
			} else {
				overlayMats.push(null);
			}

			scene.add(m);
			return m;
		});
		holoLabels = labels;

		// ---- Interaction state ----
		let targetRotY = 0,
			targetRotX = -0.05;
		let dragging = false;
		let lastX = 0,
			lastY = 0;
		let ripPull = 0; // accumulated horizontal swipe (px)
		let rip = 0,
			ripTarget = 0; // 0..1 current / target tear progress
		let committing = false;
		let ripActive = false; // true only when the swipe started at the pack's top
		let dragDX = 0;
		let pointerX = 0,
			pointerY = 0;
		const TOP_GATE = -0.12; // must grab above this (normalized Y) to rip

		function goToIndex(i: number) {
			currentIndex = Math.max(0, Math.min(total, i));
		}
		goTo = goToIndex;
		triggerRip = () => {
			if (stage === 'pack') {
				committing = true;
				ripTarget = 1;
			}
		};

		function onDown(e: PointerEvent) {
			dragging = true;
			lastX = e.clientX;
			lastY = e.clientY;
			const rect = canvas.getBoundingClientRect();
			const py = ((e.clientY - rect.top) / rect.height) * 2 - 1;
			// only allow ripping if the swipe begins near the top of the pack
			ripActive = stage === 'pack' && locked && py < TOP_GATE;
			canvas.setPointerCapture(e.pointerId);
		}
		function onMove(e: PointerEvent) {
			const dx = e.clientX - lastX;
			const dy = e.clientY - lastY;
			lastX = e.clientX;
			lastY = e.clientY;
			const rect = canvas.getBoundingClientRect();
			pointerX = ((e.clientX - rect.left) / rect.width) * 2 - 1;
			pointerY = ((e.clientY - rect.top) / rect.height) * 2 - 1;
			if (!dragging) return;
			if (stage === 'pack') {
				if (locked && ripActive) {
					// swipe across the top to progressively rip it open
					ripPull += Math.abs(dx);
					ripTarget = Math.min(ripPull / RIP_DISTANCE, 1);
					if (ripTarget >= 1) committing = true;
				} else if (!locked) {
					// rotation unlocked — drag spins the pack
					targetRotY += dx * 0.01;
					targetRotX = THREE.MathUtils.clamp(targetRotX + dy * 0.006, -0.8, 0.8);
				}
			} else if (stage === 'cards') {
				dragDX += dx;
			}
		}
		function onUp(e: PointerEvent) {
			if (stage === 'pack' && locked && ripActive && !committing) {
				// snap to fully open if swiped far enough, otherwise spring closed
				if (rip >= 0.5) {
					committing = true;
					ripTarget = 1;
				} else {
					ripTarget = 0;
					ripPull = 0;
				}
			}
			ripActive = false;
			if (stage === 'cards') {
				if (dragDX < -90 && currentIndex < total) goToIndex(currentIndex + 1);
				else if (dragDX > 90 && currentIndex > 0) goToIndex(currentIndex - 1);
			}
			dragDX = 0;
			dragging = false;
			try {
				canvas.releasePointerCapture(e.pointerId);
			} catch {
				/* ignore */
			}
		}
		canvas.addEventListener('pointerdown', onDown);
		canvas.addEventListener('pointermove', onMove);
		canvas.addEventListener('pointerup', onUp);
		canvas.addEventListener('pointercancel', onUp);

		function resize() {
			const w = canvas.clientWidth,
				h = canvas.clientHeight;
			if (!w || !h) return;
			renderer.setSize(w, h, false);
			camera.aspect = w / h;
			camera.updateProjectionMatrix();
		}
		const ro = new ResizeObserver(resize);
		ro.observe(canvas);
		resize();

		const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
		let raf = 0;
		function frame() {
			raf = requestAnimationFrame(frame);
			const now = performance.now();

			if (stage === 'pack') {
				packGroup.rotation.y = lerp(packGroup.rotation.y, targetRotY, 0.12);
				packGroup.rotation.x = lerp(packGroup.rotation.x, targetRotX, 0.12);

				rip = lerp(rip, ripTarget, 0.2);
				// sweep the peel crease across the top
				for (let k = 0; k < peelUniforms.length; k++) peelUniforms[k].value = rip;
				const torn = rip > 0.05;
				if (torn !== ripping) ripping = torn;

				if (committing && rip > 0.98) {
					stage = 'cards';
					packGroup.visible = false;
					cardMeshes.forEach((m) => (m.visible = true));
				}
			}

			if (stage === 'cards') {
				for (let i = 0; i < cardMeshes.length; i++) {
					const m = cardMeshes[i];
					const rel = i - currentIndex;
					const mat = m.material as THREE.ShaderMaterial;
					let tx = 0,
						ty = 0,
						tz = 0,
						rx = 0,
						rz = 0,
						ry = 0,
						op = 0,
						sc = 1;
					if (rel < 0) {
						tx = -11;
						tz = 1;
						rz = 0.45;
						op = 0;
					} else if (rel > 4) {
						ty = 0.5;
						tz = -2;
						op = 0;
						sc = 0.85;
					} else {
						const bob = Math.sin(now / 700 + i) * 0.04;
						ty = rel * 0.18 + bob;
						tz = -rel * 0.5;
						op = rel === 0 ? 1 : Math.max(0, 0.55 - rel * 0.12);
						sc = 1 - rel * 0.05;
						if (rel === 0) {
							// front card tilts toward the cursor on both axes so the
							// holo shifts as you move it around
							tx = dragDX * 0.01;
							rz = -dragDX * 0.0012;
							ry = pointerX * 0.32;
							rx = pointerY * 0.26;
						}
					}
					m.position.x = lerp(m.position.x, tx, 0.14);
					m.position.y = lerp(m.position.y, ty, 0.14);
					m.position.z = lerp(m.position.z, tz, 0.14);
					m.rotation.x = lerp(m.rotation.x, rx, 0.14);
					m.rotation.z = lerp(m.rotation.z, rz, 0.14);
					m.rotation.y = lerp(m.rotation.y, ry, 0.14);
					const s = lerp(m.scale.x, sc, 0.14);
					m.scale.set(s, s, s);
					mat.uniforms.uOpacity.value = lerp(mat.uniforms.uOpacity.value, op, 0.14);

					const ov = overlayMats[i];
					if (ov) {
						ov.uniforms.uOpacity.value = mat.uniforms.uOpacity.value;
					}
				}
			}

			renderer.render(scene, camera);
		}
		frame();

		return () => {
			cancelAnimationFrame(raf);
			ro.disconnect();
			canvas.removeEventListener('pointerdown', onDown);
			canvas.removeEventListener('pointermove', onMove);
			canvas.removeEventListener('pointerup', onUp);
			canvas.removeEventListener('pointercancel', onUp);
			scene.traverse((o) => {
				if (o instanceof THREE.Mesh) {
					o.geometry?.dispose();
					const mats = Array.isArray(o.material) ? o.material : [o.material];
					mats.forEach((m) => {
						(m as THREE.MeshStandardMaterial).map?.dispose();
						(m as THREE.ShaderMaterial).uniforms?.map?.value?.dispose?.();
						m.dispose();
					});
				}
			});
			renderer.dispose();
		};
	});

	function handleKey(e: KeyboardEvent) {
		if (e.key === 'Escape') onClose();
		else if (stage === 'cards' && e.key === 'ArrowRight') goTo(currentIndex + 1);
		else if (stage === 'cards' && e.key === 'ArrowLeft') goTo(currentIndex - 1);
	}
</script>

<svelte:window on:keydown={handleKey} />

<div class="overlay" role="dialog" aria-modal="true" aria-label="Opening {pack.name}">
	<button class="close" onclick={onClose} aria-label="Close">✕</button>

	<canvas bind:this={canvas}></canvas>

	{#if stage === 'pack' && locked && !ripping}
		<div class="swipe-tip" aria-hidden="true">
			<span class="swipe-hand">🖐️</span>
			<span class="swipe-label">swipe to tear</span>
		</div>
	{/if}

	<div class="hud">
		{#if stage === 'pack'}
			<p class="title">{pack.name}</p>
			<p class="hint">{locked ? 'Swipe across the top to rip it open' : 'Drag to spin the pack'}</p>
			<div class="pack-actions">
				<button
					class="lock"
					class:on={locked}
					onclick={() => (locked = !locked)}
					aria-pressed={locked}
				>
					{locked ? '🔒 Rotation locked' : '🔓 Rotation free'}
				</button>
				<button class="rip" onclick={() => triggerRip()}>Rip open</button>
			</div>
		{:else if stage === 'cards'}
			{#if currentIndex >= total}
				<p class="title">All {total} revealed</p>
				<button class="rip" onclick={onClose}>Done</button>
			{:else}
				{#if currentCard}
					<p class="card-name" style="--rarity: {currentRarity?.color}">
						{currentCard.name}
						<span class="card-sub">
							{currentRarity?.label}{#if currentCard.level} · lvl {currentCard.level}{/if}
						</span>
						{#if currentHolo}
							<span class="holo-tag">✦ {currentHolo}</span>
						{/if}
					</p>
				{/if}
				<div class="nav">
					<button onclick={() => goTo(currentIndex - 1)} disabled={currentIndex === 0} aria-label="Previous">‹</button>
					<span class="counter">{currentIndex + 1} / {total}</span>
					<button onclick={() => goTo(currentIndex + 1)} aria-label="Next">›</button>
				</div>
				<p class="hint">Swipe / drag to flip through your pull</p>
			{/if}
		{/if}
	</div>
</div>

<style>
	.overlay {
		position: fixed;
		inset: 0;
		z-index: 100;
		background: radial-gradient(circle at 50% 35%, rgba(40, 32, 24, 0.85), rgba(0, 0, 0, 0.94));
		backdrop-filter: blur(6px);
		-webkit-backdrop-filter: blur(6px);
		display: flex;
		flex-direction: column;
	}

	canvas {
		position: absolute;
		inset: 0;
		width: 100%;
		height: 100%;
		touch-action: none;
		cursor: grab;
	}

	canvas:active {
		cursor: grabbing;
	}

	.close {
		position: absolute;
		top: 1rem;
		right: 1rem;
		z-index: 2;
		width: 2.5rem;
		height: 2.5rem;
		min-height: 0;
		border-radius: 999px;
		background: rgba(0, 0, 0, 0.5);
		border: 1px solid var(--border-strong);
		color: var(--text);
		font-size: 1rem;
		cursor: pointer;
	}

	.close:hover {
		border-color: var(--accent);
		color: var(--accent);
	}

	.swipe-tip {
		position: absolute;
		top: 22%;
		left: 50%;
		transform: translateX(-50%);
		z-index: 2;
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 0.3rem;
		pointer-events: none;
		color: var(--accent);
	}

	.swipe-hand {
		font-size: 2.2rem;
		animation: swipe-move 1.5s ease-in-out infinite;
	}

	.swipe-label {
		font-family: 'rsbold', ui-sans-serif, Arial, sans-serif;
		font-size: 0.85rem;
		letter-spacing: 1px;
		color: #fff;
		text-shadow: var(--ts-strong);
	}

	@keyframes swipe-move {
		0%,
		100% {
			transform: translateX(-32px) rotate(-8deg);
		}
		50% {
			transform: translateX(32px) rotate(8deg);
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.swipe-hand {
			animation: none;
		}
	}

	.hud {
		position: absolute;
		left: 0;
		right: 0;
		bottom: 0;
		z-index: 2;
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 0.6rem;
		padding: 1.5rem;
		pointer-events: none;
		text-align: center;
	}

	.hud button {
		pointer-events: auto;
	}

	.title {
		margin: 0;
		font-family: 'rsbold', ui-sans-serif, Arial, sans-serif;
		font-size: 1.5rem;
		color: var(--accent);
		text-shadow: var(--ts-strong);
	}

	.card-name {
		margin: 0;
		font-family: 'rsbold', ui-sans-serif, Arial, sans-serif;
		font-size: 1.4rem;
		color: var(--rarity, var(--text));
		text-shadow: var(--ts-strong);
		display: flex;
		flex-direction: column;
		gap: 0.1rem;
	}

	.card-sub {
		font-family: 'rssmall', ui-sans-serif, Arial, sans-serif;
		font-size: 0.85rem;
		color: rgba(255, 255, 255, 0.7);
	}

	.holo-tag {
		font-family: 'rssmall', ui-sans-serif, Arial, sans-serif;
		font-size: 0.8rem;
		color: #fff;
		background: linear-gradient(90deg, #ff5e5e, #ffe14d, #5effa0, #5ec8ff, #b06bff);
		-webkit-background-clip: text;
		background-clip: text;
		-webkit-text-fill-color: transparent;
		text-shadow: none;
	}

	.hint {
		margin: 0;
		font-size: 0.9rem;
		color: rgba(255, 255, 255, 0.55);
		text-shadow: var(--ts);
	}

	.pack-actions {
		display: flex;
		gap: 0.6rem;
		align-items: center;
		flex-wrap: wrap;
		justify-content: center;
	}

	.lock {
		border-color: var(--border-strong);
		color: rgba(255, 255, 255, 0.8);
		background: rgba(0, 0, 0, 0.45);
		padding: 0 1rem;
	}

	.lock.on {
		border-color: var(--accent);
		color: var(--accent);
		background: rgba(255, 152, 31, 0.12);
	}

	.rip {
		border-color: var(--accent);
		color: var(--accent);
		font-family: 'rsbold', ui-sans-serif, Arial, sans-serif;
		background: rgba(255, 152, 31, 0.12);
		padding: 0 1.5rem;
	}

	.rip:hover {
		background: var(--accent-soft);
	}

	.nav {
		display: flex;
		align-items: center;
		gap: 1rem;
	}

	.nav button {
		width: 3rem;
		height: 3rem;
		min-height: 0;
		border-radius: 999px;
		font-size: 1.5rem;
		background: rgba(0, 0, 0, 0.5);
		border: 1px solid var(--border-strong);
		color: var(--text);
		cursor: pointer;
	}

	.nav button:hover:not(:disabled) {
		border-color: var(--accent);
		color: var(--accent);
	}

	.nav button:disabled {
		opacity: 0.35;
		cursor: not-allowed;
	}

	.counter {
		min-width: 4rem;
		color: rgba(255, 255, 255, 0.8);
		text-shadow: var(--ts);
	}
</style>
