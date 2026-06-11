<script lang="ts">
	import { onMount, onDestroy, untrack } from 'svelte';
	import * as THREE from 'three';
	import '$lib/cards/threeSetup'; // THREE.Cache.enabled = true (dedupe texture loads)
	import { RARITY_BY_KEY, DEFAULT_RARITY, DEFAULT_CARD_BACK, type Card } from '$lib/cards/rarity';
	import {
		FINISH_BY_KEY,
		HOLO_TEXTURE_URL,
		HOLO_MASK_URL,
		HOLO_BORDER_MASK_URL,
		type CardFinish
	} from '$lib/cards/finishes';
	import { HOLO_VERT, HOLO_FRAG, LAYER_SHADOW_FRAG, LAYER_GLOW_FRAG } from '$lib/cards/holo';
	import { createLayerEffect, type LayerEffectHandle } from '$lib/cards/layerEffects';
	import { makeEdgeFade } from '$lib/cards/edgeFade';
	import { loadLayerTexture, type LayerTextureHandle } from '$lib/cards/layerTexture';
	import { loadCardModel, type CardModelHandle } from '$lib/cards/cardModel';
	import { toCardModels } from '$lib/cards/rarity';
	import { isVideoUrl } from '$lib/cards/config';

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
	// Full-art cards ignore the finish masks, but a full-art card WITH an uploaded
	// holo image (whole card) OR holo_border (frame only) shows an intrinsic foil.
	let fullArtHolo = $derived(!!card.full_art && (!!card.holo_url || !!card.holo_border));
	let isHolo = $derived(fullArtHolo || (!card.full_art && finishMeta.key !== 'normal'));
	let finishLabel = $derived(
		fullArtHolo ? (card.holo_border ? 'Reverse Holo' : 'Holo') : finishMeta.label
	);

	// Imperative bridge: set by onMount so the toggle can update the 3D material.
	let applyFinish: (f: CardFinish) => void = () => {};
	function setFinish(f: CardFinish) {
		activeFinish = f;
		applyFinish(f);
	}

	// Play the card's open sound on demand (if it has one), at the chosen volume.
	// Volume is shared with the pack opener (same localStorage key) and persisted.
	let audio: HTMLAudioElement | null = null;
	let volume = $state(1); // 0..1
	function playSound() {
		if (!card.sound_url) return;
		try {
			if (!audio) audio = new Audio(card.sound_url);
			audio.volume = volume;
			audio.currentTime = 0;
			void audio.play().catch(() => {});
		} catch {
			/* autoplay/format issues are non-fatal */
		}
	}
	onMount(() => {
		try {
			const v = parseFloat(localStorage.getItem('vs_po_volume') ?? '1');
			if (Number.isFinite(v)) volume = Math.min(1, Math.max(0, v));
		} catch {
			/* ignore */
		}
	});
	$effect(() => {
		try {
			localStorage.setItem('vs_po_volume', String(volume));
		} catch {
			/* ignore */
		}
		if (audio) audio.volume = volume;
	});
	onDestroy(() => {
		try {
			audio?.pause();
			if (audio) audio.src = '';
		} catch {
			/* ignore */
		}
	});

	function onKey(e: KeyboardEvent) {
		if (e.key === 'Escape') onClose();
	}

	function loadDims(url: string | null, fallback: { w: number; h: number }) {
		return new Promise<{ w: number; h: number }>((resolve) => {
			if (!url) return resolve(fallback);
			if (isVideoUrl(url)) {
				const v = document.createElement('video');
				v.preload = 'metadata';
				v.muted = true;
				v.onloadedmetadata = () =>
					resolve({ w: v.videoWidth || fallback.w, h: v.videoHeight || fallback.h });
				v.onerror = () => resolve(fallback);
				v.src = url;
				return;
			}
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
			// Lets a model's `clip` setting cut away geometry behind the card face.
			// No-op for materials without clippingPlanes (the card's own shaders).
			renderer.localClippingEnabled = true;

			const loader = new THREE.TextureLoader();
			const group = new THREE.Group();
			scene.add(group);

			// The card itself uses unlit shader/basic materials, so this scene normally has
			// NO lights. A .glb model uses PBR (MeshStandardMaterial), which renders BLACK
			// without lighting — add lights only when the card actually has a model.
			const cardModels = toCardModels(card);
			if (cardModels.length) {
				scene.add(new THREE.AmbientLight(0xffffff, 0.9));
				const key = new THREE.DirectionalLight(0xffffff, 1.1);
				key.position.set(3, 5, 6);
				scene.add(key);
				const fill = new THREE.DirectionalLight(0xffffff, 0.5);
				fill.position.set(-4, 2, 4);
				scene.add(fill);
			}

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
					uOpacity: { value: 1 },
					uEdgeFade: { value: 0.03 },
					uMapSrgb: { value: 0 }
				},
				vertexShader: HOLO_VERT,
				fragmentShader: HOLO_FRAG,
				transparent: true
			});
			// Swap the foil/mask for a finish (live — used by the toggle and at init).
			applyFinish = (f: CardFinish) => {
				// Full-art card: no rolled finish masks. An intrinsic foil applies if it
				// has an uploaded holo image (whole card) or holo_border (frame only).
				// Border holo's foil = the uploaded holo_url if set, else the reverse ripple.
				if (card.full_art) {
					if (card.holo_url || card.holo_border) {
						frontMat.uniforms.uHas.value = 1;
						frontMat.uniforms.uStrength.value = 1;
						frontMat.uniforms.uHoloTex.value = holoTexFor(
							card.holo_url ?? HOLO_TEXTURE_URL.ripple,
							true,
							true
						);
						frontMat.uniforms.uMask.value = card.holo_border
							? holoTexFor(HOLO_BORDER_MASK_URL, false, false)
							: dummy;
						// Border foil sits in the thin frame — shrink the edge fade so it
						// doesn't fade the frame away; whole-card foil keeps the default.
						frontMat.uniforms.uEdgeFade.value = card.holo_border ? 0.006 : 0.03;
					} else {
						frontMat.uniforms.uHas.value = 0;
					}
					return;
				}
				const meta = FINISH_BY_KEY[f] ?? FINISH_BY_KEY.normal;
				frontMat.uniforms.uHas.value = meta.placement ? 1 : 0;
				frontMat.uniforms.uStrength.value = meta.strength;
				// Foil = the card's pack holo override for this finish, else the default.
				frontMat.uniforms.uHoloTex.value =
					meta.placement === 'regular'
						? holoTexFor(card.holo_regular_url ?? HOLO_TEXTURE_URL.star, true, true)
						: meta.placement === 'reverse'
							? holoTexFor(card.holo_reverse_url ?? HOLO_TEXTURE_URL.ripple, true, true)
							: dummy;
				frontMat.uniforms.uMask.value = meta.placement
					? holoTexFor(HOLO_MASK_URL[meta.placement], false, false)
					: dummy;
			};
			applyFinish(activeFinish);
			// A video front animates as a looping VideoTexture (disposed in teardown);
			// a still image uses the texture loader. three doesn't sRGB-decode a
			// VideoTexture on sample, so for video we mark it linear (no decode) and let
			// the shader decode (uMapSrgb) — otherwise the video renders too bright.
			let frontHandle: LayerTextureHandle | null = null;
			if (isVideoUrl(frontUrl)) {
				frontHandle = loadLayerTexture(loader, frontUrl, (t) => {
					t.colorSpace = THREE.LinearSRGBColorSpace;
					frontMat.uniforms.uMapSrgb.value = 1;
					frontMat.uniforms.map.value = t;
					frontMat.needsUpdate = true;
				});
			} else {
				loader.load(frontUrl, (t) => {
					t.colorSpace = THREE.SRGBColorSpace;
					frontMat.uniforms.map.value = t;
					frontMat.needsUpdate = true;
				});
			}
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
			// Soft edge-fade mask: layer art that reaches the card border feathers out
			// instead of hard-cutting into a straight line, and the square plane corners
			// don't poke past the card's rounded silhouette. Shared by all layers.
			const edgeFade = (card.layers ?? []).length ? makeEdgeFade() : null;
			// Image/video texture handles, disposed on teardown (video also gets paused).
			const layerTexHandles: LayerTextureHandle[] = [];
			// Live per-layer animation effects (see layerEffects.ts), updated each frame.
			const fxHandles: LayerEffectHandle[] = [];
			(card.layers ?? []).forEach((ly, i) => {
				const h = (i + 1) * LAYER_DEPTH;
				const lm = new THREE.MeshBasicMaterial({ transparent: true });
				if (edgeFade) lm.alphaMap = edgeFade;
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
				// Glow-effect materials for this layer share the layer texture once it loads.
				const glowMaps: { value: THREE.Texture | null }[] = [];
				layerTexHandles.push(
					loadLayerTexture(loader, ly.url, (t) => {
						t.colorSpace = THREE.SRGBColorSpace;
						lm.map = t;
						lm.needsUpdate = true;
						sm.uniforms.map.value = t; // shadow reuses the layer texture (alpha)
						for (const m of glowMaps) m.value = t;
					})
				);
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

				if (ly.effect) {
					fxHandles.push(
						createLayerEffect(ly.effect, {
							mesh: lp,
							baseZ: h,
							index: i,
							makeGlow: ({ blur }) => {
								const gmat = new THREE.ShaderMaterial({
									uniforms: {
										map: { value: lm.map },
										uIntensity: { value: 0 },
										uBlur: { value: new THREE.Vector2(blur, blur) },
										uFeather: { value: new THREE.Vector2(0.12, 0.12) },
										uTint: { value: new THREE.Color(1, 1, 1) }
									},
									vertexShader: HOLO_VERT,
									fragmentShader: LAYER_GLOW_FRAG,
									transparent: true,
									blending: THREE.AdditiveBlending,
									depthWrite: false
								});
								glowMaps.push(gmat.uniforms.map);
								const gmesh = new THREE.Mesh(new THREE.PlaneGeometry(CARD_W, CARD_H), gmat);
								gmesh.position.z = h + 0.002;
								gmesh.renderOrder = 3;
								group.add(gmesh);
								return {
									setIntensity: (v) => (gmat.uniforms.uIntensity.value = v),
									dispose: () => {
										group.remove(gmesh);
										gmesh.geometry.dispose();
										gmat.dispose();
									}
								};
							}
						})
					);
				}
			});

			// Optional .glb model(s), hovering above the top depth layer. Loaded async; the
			// `disposed` guard handles the modal closing before they resolve.
			const modelHandles: CardModelHandle[] = [];
			{
				const baseZ = ((card.layers ?? []).length + 1) * LAYER_DEPTH + 0.15;
				for (const m of cardModels) {
					loadCardModel(group, m.url, m.settings ?? {}, { cardW: CARD_W, cardH: CARD_H, baseZ, camera }).then(
						(h) => {
							if (disposed) h.dispose();
							else modelHandles.push(h);
						}
					);
				}
			}

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
			// Track how fast the card is being turned (drag rotation, not idle sway),
			// smoothed, to drive the layer effects — they only play while you spin it.
			let prevSpinY = 0;
			let prevSpinX = 0;
			let spinSpeed = 0;
			let lastNow = performance.now();
			function frame() {
				raf = requestAnimationFrame(frame);
				const now = performance.now();
				spinY = lerp(spinY, targetRotY, 0.12);
				spinX = lerp(spinX, targetRotX, 0.12);
				// gentle idle sway so the holo keeps shimmering when not dragging
				const sway = dragging ? 0 : 1;
				group.rotation.y = spinY + sway * Math.sin(now * 0.0009) * 0.05;
				group.rotation.x = spinX + sway * Math.sin(now * 0.0007) * 0.03;
				const dt = Math.min(0.05, (now - lastNow) / 1000);
				// Drive per-layer effects by spin speed (0 at rest → no animation).
				// The raw drag velocity is spiky (pointer events don't land every frame),
				// so smooth it with a fast attack / slow release: it ramps up quickly,
				// holds steady between input spikes, and glides back down when you stop —
				// otherwise the effects flicker.
				if (fxHandles.length) {
					const d = Math.abs(spinY - prevSpinY) + Math.abs(spinX - prevSpinX);
					prevSpinY = spinY;
					prevSpinX = spinX;
					const target = Math.min(1, d * 12);
					spinSpeed = lerp(spinSpeed, target, target > spinSpeed ? 0.25 : 0.05);
					for (const fx of fxHandles) fx.update({ dt, spin: spinSpeed });
				}
				// Play the model's embedded animation (and optional idle spin); it already
				// inherits the card's tilt as a child of `group`.
				for (const h of modelHandles) h.update(dt, spinSpeed);
				lastNow = now;
				renderer.render(scene, camera);
			}
			frame();

			teardown = () => {
				cancelAnimationFrame(raf);
				ro.disconnect();
				frontHandle?.dispose();
				for (const h of modelHandles) h.dispose();
				fxHandles.forEach((fx) => fx.dispose());
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
				layerTexHandles.forEach((h) => h.dispose());
				edgeFade?.dispose();
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
				<span class="badge holo-badge">{finishLabel}</span>
			{/if}
			{#if card.quantity && card.quantity > 0}
				<span class="badge owned">×{card.quantity} owned</span>
			{/if}
			{#if card.sound_url}
				<span class="sound-ctl">
					<button class="sound-btn" onclick={playSound} title="Play sound">
						{volume === 0 ? '🔇' : '🔊'} Play
					</button>
					<input
						class="sound-vol"
						type="range"
						min="0"
						max="1"
						step="0.01"
						bind:value={volume}
						aria-label="Sound volume"
					/>
				</span>
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

	{#if allowFinishToggle && !card.full_art}
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
	{:else if allowFinishToggle && card.full_art}
		<p class="full-art-note">{card.holo_border ? 'Full art — border reverse holo' : card.holo_url ? 'Full art — full-card holo' : 'Full art — no holo'}</p>
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

	/* Interactive, so it opts back into pointer events (the HUD is non-interactive). */
	.sound-ctl {
		display: inline-flex;
		align-items: center;
		gap: 0.4rem;
		pointer-events: auto;
	}

	.sound-btn {
		min-height: auto;
		padding: 0.12rem 0.6rem;
		border-radius: 999px;
		border: 1px solid var(--border-strong);
		background: rgba(0, 0, 0, 0.5);
		color: var(--text);
		font-size: 0.75rem;
		cursor: pointer;
		pointer-events: auto;
	}

	.sound-btn:hover {
		border-color: var(--accent);
		color: var(--accent);
	}

	.sound-vol {
		width: 5rem;
		accent-color: var(--accent);
		cursor: pointer;
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

	.full-art-note {
		position: absolute;
		bottom: 2.5rem;
		left: 50%;
		transform: translateX(-50%);
		margin: 0;
		padding: 0.25rem 0.7rem;
		font-size: 0.78rem;
		color: var(--muted);
		background: rgba(0, 0, 0, 0.5);
		border: 1px solid var(--border);
		border-radius: 999px;
		pointer-events: none;
		text-shadow: 0 2px 8px rgba(0, 0, 0, 0.85);
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
