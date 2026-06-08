<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import * as THREE from 'three';
	import { RARITY_BY_KEY, DEFAULT_RARITY, DEFAULT_CARD_BACK, type Card } from '$lib/cards/rarity';
	import {
		FINISH_BY_KEY,
		HOLO_TEXTURE_URL,
		HOLO_MASK_URL,
		type CardFinish
	} from '$lib/cards/finishes';
	import { HOLO_VERT, HOLO_FRAG, LAYER_SHADOW_FRAG } from '$lib/cards/holo';

	let {
		card,
		onClose,
		allowFinishToggle = false
	}: {
		card: Card & { finish?: CardFinish; quantity?: number | null };
		onClose: () => void;
		// When true, show a Normal/Holo/Reverse switcher (admin preview); the foil
		// is swapped live without rebuilding the scene.
		allowFinishToggle?: boolean;
	} = $props();

	let canvas: HTMLCanvasElement;

	let rarity = $derived(RARITY_BY_KEY[card.rarity] ?? RARITY_BY_KEY[DEFAULT_RARITY]);
	// The finish currently being shown (live-switchable when allowFinishToggle).
	// untrack: capture only the initial finish — the inspector remounts per card.
	let activeFinish = $state<CardFinish>(untrack(() => card.finish ?? 'normal'));
	let finishMeta = $derived(FINISH_BY_KEY[activeFinish] ?? FINISH_BY_KEY.normal);
	let isHolo = $derived(finishMeta.key !== 'normal');

	// Imperative bridge: set by onMount so the toggle can update the 3D material.
	let applyFinish: (f: CardFinish) => void = () => {};
	function setFinish(f: CardFinish) {
		activeFinish = f;
		applyFinish(f);
	}

	function onKey(e: KeyboardEvent) {
		if (e.key === 'Escape') onClose();
	}

	function loadDims(url: string | null, fallback: { w: number; h: number }) {
		return new Promise<{ w: number; h: number }>((resolve) => {
			if (!url) return resolve(fallback);
			const img = new Image();
			img.onload = () => resolve({ w: img.naturalWidth || fallback.w, h: img.naturalHeight || fallback.h });
			img.onerror = () => resolve(fallback);
			img.src = url;
		});
	}

	onMount(() => {
		let disposed = false;
		let teardown = () => {};

		(async () => {
			const frontUrl = card.front_url || DEFAULT_CARD_BACK;
			const backUrl = card.back_url || DEFAULT_CARD_BACK;
			const dims = await loadDims(frontUrl, { w: 5, h: 7 });
			if (disposed) return;

			const CARD_H = 4;
			const CARD_W = CARD_H * (dims.w / dims.h);
			const CARD_D = 0.04;

			const scene = new THREE.Scene();
			const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 100);
			camera.position.set(0, 0, 8);

			const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
			renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

			const loader = new THREE.TextureLoader();
			const group = new THREE.Group();
			scene.add(group);

			// 1x1 white stand-in so the foil/mask samplers are always bound, even for
			// a Normal card (uHas = 0 means the shader never reads them).
			const dummy = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
			dummy.needsUpdate = true;

			// Holo foil + mask textures, cached by URL so switching finishes (the admin
			// toggle) reuses them instead of reloading.
			const texCache = new Map<string, THREE.Texture>();
			function holoTexFor(url: string, srgb: boolean, mirror: boolean) {
				const hit = texCache.get(url);
				if (hit) return hit;
				const t = loader.load(url);
				if (srgb) t.colorSpace = THREE.SRGBColorSpace;
				t.wrapS = t.wrapT = mirror
					? THREE.MirroredRepeatWrapping
					: THREE.ClampToEdgeWrapping;
				texCache.set(url, t);
				return t;
			}

			// Front: holo shader plane. Foil uniforms are filled by applyFinish below.
			const frontMat = new THREE.ShaderMaterial({
				uniforms: {
					map: { value: null },
					uHoloTex: { value: dummy },
					uMask: { value: dummy },
					uHas: { value: 0 },
					uStrength: { value: 0 },
					uReveal: { value: 1 },
					uOpacity: { value: 1 }
				},
				vertexShader: HOLO_VERT,
				fragmentShader: HOLO_FRAG,
				transparent: true
			});
			// Swap the foil/mask for a finish (live — used by the toggle and at init).
			applyFinish = (f: CardFinish) => {
				const meta = FINISH_BY_KEY[f] ?? FINISH_BY_KEY.normal;
				frontMat.uniforms.uHas.value = meta.placement ? 1 : 0;
				frontMat.uniforms.uStrength.value = meta.strength;
				frontMat.uniforms.uHoloTex.value = meta.texture
					? holoTexFor(HOLO_TEXTURE_URL[meta.texture], true, true)
					: dummy;
				frontMat.uniforms.uMask.value = meta.placement
					? holoTexFor(HOLO_MASK_URL[meta.placement], false, false)
					: dummy;
			};
			applyFinish(activeFinish);
			loader.load(frontUrl, (t) => {
				t.colorSpace = THREE.SRGBColorSpace;
				frontMat.uniforms.map.value = t;
				frontMat.needsUpdate = true;
			});
			const front = new THREE.Mesh(new THREE.PlaneGeometry(CARD_W, CARD_H), frontMat);
			group.add(front);

			// Thin dark edge for a little thickness.
			const edge = new THREE.Mesh(
				new THREE.BoxGeometry(CARD_W, CARD_H, CARD_D),
				new THREE.MeshBasicMaterial({ color: 0x0c0c0e })
			);
			edge.position.z = -CARD_D / 2 - 0.001;
			group.add(edge);

			// Back face (shown once flipped past 90°).
			const backMat = new THREE.MeshBasicMaterial({ transparent: true });
			loader.load(backUrl, (t) => {
				t.colorSpace = THREE.SRGBColorSpace;
				backMat.map = t;
				backMat.needsUpdate = true;
			});
			const back = new THREE.Mesh(new THREE.PlaneGeometry(CARD_W, CARD_H), backMat);
			back.rotation.y = Math.PI;
			back.position.z = -(CARD_D + 0.006);
			group.add(back);

			// Stacked 3D depth layers above the front. Each layer is raised in z (so
			// rotating parallaxes them apart) AND casts a soft drop shadow onto the
			// card base, thrown toward a fixed light by its height — that grounds it so
			// it reads as popping OUT of the card rather than floating above it.
			const LAYER_DEPTH = 0.08; // how far each layer sits above the card (small = subtle)
			const SHADOW_DIR = new THREE.Vector2(0.6, -0.8); // light upper-left → shadow lower-right
			const layerMats: THREE.MeshBasicMaterial[] = [];
			(card.layers ?? []).forEach((ly, i) => {
				const h = (i + 1) * LAYER_DEPTH;
				const lm = new THREE.MeshBasicMaterial({ transparent: true });
				const sm = new THREE.ShaderMaterial({
					uniforms: {
						map: { value: null },
						uOpacity: { value: 0.5 },
						uBlur: { value: new THREE.Vector2(0.012 * (i + 1), 0.012 * (i + 1)) }
					},
					vertexShader: HOLO_VERT,
					fragmentShader: LAYER_SHADOW_FRAG,
					transparent: true,
					depthWrite: false
				});
				loader.load(ly.url, (t) => {
					t.colorSpace = THREE.SRGBColorSpace;
					lm.map = t;
					lm.needsUpdate = true;
					sm.uniforms.map.value = t; // shadow reuses the layer texture (alpha)
				});
				// Force draw order front(0) → shadow(1) → layer(2) so the transparency
				// sort never flips the shadow behind the front (which made it vanish).
				const shadow = new THREE.Mesh(new THREE.PlaneGeometry(CARD_W, CARD_H), sm);
				shadow.position.set(SHADOW_DIR.x * h * 1.1, SHADOW_DIR.y * h * 1.1, 0.002 + i * 0.0015);
				shadow.renderOrder = 1;
				group.add(shadow);
				// the layer itself, raised above the card
				const lp = new THREE.Mesh(new THREE.PlaneGeometry(CARD_W, CARD_H), lm);
				lp.position.z = h;
				lp.renderOrder = 2;
				group.add(lp);
				layerMats.push(lm);
			});

			// ---- Interaction: drag to rotate, tap to flip ----
			let targetRotY = 0;
			let targetRotX = 0;
			let spinY = 0;
			let spinX = 0;
			let dragging = false;
			let lastX = 0;
			let lastY = 0;
			let downX = 0;
			let downY = 0;

			function onDown(e: PointerEvent) {
				dragging = true;
				lastX = downX = e.clientX;
				lastY = downY = e.clientY;
				canvas.setPointerCapture(e.pointerId);
			}
			function onMove(e: PointerEvent) {
				if (!dragging) return;
				const dx = e.clientX - lastX;
				const dy = e.clientY - lastY;
				lastX = e.clientX;
				lastY = e.clientY;
				targetRotY += dx * 0.01;
				targetRotX = THREE.MathUtils.clamp(targetRotX + dy * 0.01, -1.2, 1.2);
			}
			function onUp(e: PointerEvent) {
				const tap = Math.hypot(e.clientX - downX, e.clientY - downY) < 8;
				if (tap) targetRotY += Math.PI; // flip
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

			function fit() {
				const w = canvas.clientWidth || 1;
				const h = canvas.clientHeight || 1;
				renderer.setSize(w, h, false);
				camera.aspect = w / h;
				const vFov = (camera.fov * Math.PI) / 180;
				// fill most of the screen, with a little breathing room
				const distH = (CARD_H * 1.18) / (2 * Math.tan(vFov / 2));
				const distW = (CARD_W * 1.18) / (2 * Math.tan(vFov / 2) * (w / h));
				camera.position.z = Math.max(distH, distW);
				camera.updateProjectionMatrix();
			}
			fit();
			const ro = new ResizeObserver(fit);
			ro.observe(canvas);

			let raf = 0;
			const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
			function frame() {
				raf = requestAnimationFrame(frame);
				const now = performance.now();
				spinY = lerp(spinY, targetRotY, 0.12);
				spinX = lerp(spinX, targetRotX, 0.12);
				// gentle idle sway so the holo keeps shimmering when not dragging
				const sway = dragging ? 0 : 1;
				group.rotation.y = spinY + sway * Math.sin(now * 0.0009) * 0.05;
				group.rotation.x = spinX + sway * Math.sin(now * 0.0007) * 0.03;
				renderer.render(scene, camera);
			}
			frame();

			teardown = () => {
				cancelAnimationFrame(raf);
				ro.disconnect();
				canvas.removeEventListener('pointerdown', onDown);
				canvas.removeEventListener('pointermove', onMove);
				canvas.removeEventListener('pointerup', onUp);
				scene.traverse((o) => {
					const m = o as THREE.Mesh;
					if (m.geometry) m.geometry.dispose();
					const mat = m.material as THREE.Material | THREE.Material[] | undefined;
					if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
					else if (mat) mat.dispose();
				});
				frontMat.uniforms.map.value?.dispose?.();
				backMat.map?.dispose?.();
				texCache.forEach((t) => t.dispose());
				layerMats.forEach((m) => m.map?.dispose?.());
				dummy.dispose();
				renderer.dispose();
			};
		})();

		return () => {
			disposed = true;
			teardown();
		};
	});
</script>

<svelte:window onkeydown={onKey} />

<!-- Full-screen inspect: the canvas fills the viewport, metadata is overlaid. -->
<div class="overlay">
	<canvas bind:this={canvas}></canvas>

	<button class="close" onclick={onClose} aria-label="Close">×</button>

	<div class="info top">
		<h2>{card.name}</h2>
		<div class="sub">
			<span class="rarity" style="--rarity:{rarity.color}">
				{rarity.label}{#if card.level} · lvl {card.level}{/if}
			</span>
			{#if isHolo}
				<span class="badge holo-badge">{finishMeta.label}</span>
			{/if}
			{#if card.quantity && card.quantity > 0}
				<span class="badge owned">×{card.quantity} owned</span>
			{/if}
		</div>
	</div>

	{#if card.abilities.length || card.flavor}
		<div class="info detail">
			{#if card.abilities.length}
				<ul class="abilities">
					{#each card.abilities as ab}
						<li><strong>{ab.name}</strong>{#if ab.description} — {ab.description}{/if}</li>
					{/each}
				</ul>
			{/if}
			{#if card.flavor}
				<p class="flavor">"{card.flavor}"</p>
			{/if}
		</div>
	{/if}

	{#if allowFinishToggle}
		<div class="finish-toggle">
			<button type="button" class:active={activeFinish === 'normal'} onclick={() => setFinish('normal')}>
				Normal
			</button>
			<button type="button" class:active={activeFinish === 'holo'} onclick={() => setFinish('holo')}>
				Holo
			</button>
			<button type="button" class:active={activeFinish === 'reverse'} onclick={() => setFinish('reverse')}>
				Reverse Holo
			</button>
		</div>
	{/if}

	<p class="hint">Drag to rotate · tap to flip · Esc to close</p>
</div>

<style>
	.overlay {
		position: fixed;
		inset: 0;
		z-index: 100;
		background: radial-gradient(circle at 50% 38%, rgba(22, 18, 13, 0.94), rgba(0, 0, 0, 0.97));
		animation: fade 0.15s ease-out;
	}

	@keyframes fade {
		from {
			opacity: 0;
		}
	}

	canvas {
		position: absolute;
		inset: 0;
		width: 100%;
		height: 100%;
		display: block;
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
		width: 2.4rem;
		height: 2.4rem;
		min-height: auto;
		padding: 0;
		display: flex;
		align-items: center;
		justify-content: center;
		font-size: 1.6rem;
		line-height: 1;
		background: rgba(0, 0, 0, 0.45);
		border: 1px solid var(--border);
		border-radius: 999px;
		color: var(--muted);
		cursor: pointer;
	}

	.close:hover {
		color: var(--text);
		border-color: var(--border-strong);
	}

	/* Overlaid HUD — non-interactive so drags fall through to the canvas. */
	.info {
		position: absolute;
		z-index: 1;
		pointer-events: none;
		text-shadow: 0 2px 8px rgba(0, 0, 0, 0.85);
	}

	.info.top {
		top: 1.1rem;
		left: 50%;
		transform: translateX(-50%);
		text-align: center;
		max-width: 92vw;
	}

	.info.top h2 {
		margin: 0 0 0.35rem;
		font-size: 1.7rem;
		line-height: 1.1;
	}

	.sub {
		display: flex;
		flex-wrap: wrap;
		gap: 0.4rem;
		align-items: center;
		justify-content: center;
	}

	.rarity {
		color: var(--rarity);
		font-size: 0.95rem;
	}

	.badge {
		padding: 0.1rem 0.55rem;
		border-radius: 999px;
		border: 1px solid var(--border);
		background: rgba(0, 0, 0, 0.45);
		color: var(--muted);
		font-size: 0.75rem;
	}

	.badge.holo-badge {
		border-color: #b06bff;
		color: #d7b3ff;
		background: rgba(176, 107, 255, 0.18);
	}

	.badge.owned {
		color: var(--text);
	}

	.info.detail {
		left: 1.25rem;
		bottom: 2.8rem;
		max-width: min(24rem, 82vw);
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}

	.abilities {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 0.4rem;
	}

	.abilities li {
		font-size: 0.85rem;
		line-height: 1.35;
		padding: 0.4rem 0.6rem;
		background: rgba(20, 16, 12, 0.72);
		border: 1px solid var(--border);
		border-radius: var(--radius);
	}

	.abilities strong {
		color: var(--accent);
	}

	.flavor {
		margin: 0;
		font-style: italic;
		color: var(--muted);
		font-size: 0.85rem;
	}

	.hint {
		position: absolute;
		bottom: 1rem;
		left: 50%;
		transform: translateX(-50%);
		margin: 0;
		color: var(--muted);
		font-size: 0.8rem;
		pointer-events: none;
		text-shadow: 0 2px 8px rgba(0, 0, 0, 0.85);
	}

	/* Finish preview switcher (admin). Interactive, so it opts back into pointer events. */
	.finish-toggle {
		position: absolute;
		bottom: 2.5rem;
		left: 50%;
		transform: translateX(-50%);
		z-index: 2;
		display: flex;
		gap: 0.3rem;
		pointer-events: auto;
	}

	.finish-toggle button {
		min-height: auto;
		padding: 0.3rem 0.75rem;
		font-size: 0.8rem;
		background: rgba(0, 0, 0, 0.55);
		border: 1px solid var(--border);
		border-radius: 999px;
		color: var(--muted);
		cursor: pointer;
	}

	.finish-toggle button:hover {
		color: var(--text);
		border-color: var(--border-strong);
	}

	.finish-toggle button.active {
		color: var(--accent);
		border-color: var(--accent);
		background: var(--accent-soft, rgba(255, 152, 31, 0.16));
	}

	@media (max-width: 560px) {
		.info.top h2 {
			font-size: 1.35rem;
		}

		.info.detail {
			left: 0.75rem;
			right: 0.75rem;
			bottom: 2.6rem;
			max-width: none;
		}
	}
</style>
