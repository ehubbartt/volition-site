<script lang="ts">
	import { onMount } from 'svelte';
	import * as THREE from 'three';
	import '$lib/cards/threeSetup'; // THREE.Cache.enabled = true (dedupe texture loads)
	import { DEFAULT_PACK_FRONT } from '$lib/cards/packs';
	import {
		addPackLights,
		makePackEnv,
		buildPackMesh,
		fitPackCamera,
		loadPackAspect
	} from '$lib/cards/packScene';
	import { prefersReducedMotion, detectWebgl } from '$lib/cards/glCapabilities';

	// Per-card idle 3D pack: a real three.js pack (matching the opener's look) that
	// slowly spins + bobs on a pedestal. The WebGL context is created only while the
	// card is on-screen (IntersectionObserver) and fully disposed when it scrolls
	// away, so live contexts ≈ visible packs (the browser caps WebGL contexts at
	// ~8–16). Falls back to a static front image under reduced-motion / no-WebGL.
	let {
		front,
		back,
		name = ''
	}: { front: string | null; back: string | null; name?: string } = $props();

	const SPIN = 0.5; // rad/s
	const TILT = -0.05;

	let container: HTMLDivElement;
	let canvas = $state<HTMLCanvasElement | undefined>();
	let mode = $state<'pending' | 'gl' | 'img'>('pending');
	let active = $state(false);

	// three.js handles (plain — not reactive). built tracks whether the GL scene exists.
	let built = false;
	let building = false;
	let buildToken = 0;
	let renderer: THREE.WebGLRenderer | null = null;
	let scene: THREE.Scene | null = null;
	let camera: THREE.PerspectiveCamera | null = null;
	let envTex: THREE.Texture | null = null;
	let ro: ResizeObserver | null = null;
	let raf = 0;

	async function build() {
		if (built || building || mode !== 'gl') return;
		building = true;
		const token = ++buildToken;

		const aspect = await loadPackAspect(front);
		// Bailed out (torn down / scrolled away) while loading, or canvas gone.
		if (token !== buildToken || !active || !canvas) {
			building = false;
			return;
		}

		const packW = 3.5;
		const packH = 3.5 * aspect;

		scene = new THREE.Scene();
		camera = new THREE.PerspectiveCamera(42, 1, 0.1, 100);
		camera.position.set(0, 0, 8);

		renderer = new THREE.WebGLRenderer({
			canvas,
			antialias: true,
			alpha: true,
			powerPreference: 'high-performance'
		});
		renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));

		envTex = makePackEnv(renderer);
		scene.environment = envTex;
		addPackLights(scene);

		const loader = new THREE.TextureLoader();
		loader.crossOrigin = 'anonymous';
		const group = buildPackMesh({ frontUrl: front, backUrl: back, packW, packH, loader });
		group.rotation.x = TILT;
		const baseY = 0; // float centered in the case opening
		group.position.y = baseY;
		scene.add(group);

		const amp = packH * 0.03;
		const fit = () => {
			if (!renderer || !camera || !canvas) return;
			const w = canvas.clientWidth;
			const h = canvas.clientHeight;
			if (!w || !h) return;
			renderer.setSize(w, h, false);
			// Leave margin around the pack so the case walls stay visible.
			fitPackCamera(camera, w, h, packW, packH, 0.66, 0.8);
		};
		ro = new ResizeObserver(fit);
		ro.observe(canvas);
		fit();

		let last = performance.now();
		const loop = () => {
			raf = requestAnimationFrame(loop);
			const now = performance.now();
			const dt = Math.min(0.05, (now - last) / 1000);
			last = now;
			group.rotation.y += SPIN * dt;
			group.position.y = baseY + Math.sin(now * 0.0016) * amp;
			renderer!.render(scene!, camera!);
		};
		raf = requestAnimationFrame(loop);

		built = true;
		building = false;
	}

	function teardown() {
		buildToken++; // invalidate any in-flight build()
		if (!built) return;
		built = false;
		cancelAnimationFrame(raf);
		ro?.disconnect();
		ro = null;
		scene?.traverse((o) => {
			const mesh = o as THREE.Mesh;
			if (mesh.geometry) mesh.geometry.dispose();
			const raw = (mesh as THREE.Mesh).material;
			if (!raw) return;
			const mats = Array.isArray(raw) ? raw : [raw];
			for (const m of mats) {
				// Dispose the per-instance art texture; leave the shared foil normal map.
				(m as THREE.MeshStandardMaterial).map?.dispose();
				m.dispose();
			}
		});
		envTex?.dispose();
		envTex = null;
		renderer?.dispose();
		renderer?.forceContextLoss();
		renderer = null;
		scene = null;
		camera = null;
	}

	// Build when the card is on-screen, tear down when it leaves.
	$effect(() => {
		if (mode !== 'gl') return;
		if (active && !built) build();
		else if (!active && built) teardown();
	});

	onMount(() => {
		// Static image instead of live 3D when the user asked for reduced motion, has no
		// WebGL, or is on a SOFTWARE renderer (no GPU) — the last is the usual cause of
		// "packs load super slow", so we skip the heavy CPU render entirely. The /gamba
		// page surfaces a matching hint telling them what to change.
		if (prefersReducedMotion() || detectWebgl().tier !== 'ok') {
			mode = 'img';
			return;
		}
		mode = 'gl';
		const io = new IntersectionObserver(
			(entries) => {
				active = entries[0]?.isIntersecting ?? false;
			},
			{ rootMargin: '200px' }
		);
		io.observe(container);
		return () => {
			io.disconnect();
			teardown();
		};
	});
</script>

<div class="pack3d" bind:this={container} role="img" aria-label={name ? `${name} pack` : 'Card pack'}>
	<!-- Faux 3D display case: a back wall + four receding walls so the pack looks
	     like it's floating inside a shadow box. -->
	<div class="case">
		<div class="wall back"></div>
		<div class="wall top"></div>
		<div class="wall bottom"></div>
		<div class="wall left"></div>
		<div class="wall right"></div>
		<div class="glow"></div>
	</div>
	{#if mode === 'img'}
		<img class="flat" src={front || DEFAULT_PACK_FRONT} alt={name} />
	{:else}
		<canvas bind:this={canvas}></canvas>
	{/if}
</div>

<style>
	.pack3d {
		position: absolute;
		inset: 0;
	}

	canvas {
		position: absolute;
		inset: 0;
		width: 100%;
		height: 100%;
		z-index: 1;
		display: block;
	}

	.flat {
		position: absolute;
		inset: 16%;
		width: auto;
		height: auto;
		object-fit: contain;
		z-index: 1;
		filter: drop-shadow(0 10px 14px rgba(0, 0, 0, 0.65));
	}

	/* ── Faux 3D shadow-box interior (behind the transparent canvas) ── */
	.case {
		position: absolute;
		inset: 0;
		z-index: 0;
		overflow: hidden;
	}

	.wall {
		position: absolute;
		inset: 0;
	}

	/* Back wall — the far face of the box (inner rectangle inset ~16%). */
	.wall.back {
		clip-path: polygon(16% 16%, 84% 16%, 84% 84%, 16% 84%);
		background: radial-gradient(ellipse at 50% 42%, #352a1d 0%, #160f09 78%);
		box-shadow: inset 0 0 24px rgba(0, 0, 0, 0.6);
	}

	/* Ceiling — recedes from the top edge back to the inner top edge (in shadow). */
	.wall.top {
		clip-path: polygon(0 0, 100% 0, 84% 16%, 16% 16%);
		background: linear-gradient(#0b0806, #19120a);
	}

	/* Floor — recedes from the bottom edge (catches a little light). */
	.wall.bottom {
		clip-path: polygon(0 100%, 100% 100%, 84% 84%, 16% 84%);
		background: linear-gradient(#15100a, #271e12);
	}

	/* Left + right walls — gradient darkens toward the front opening edge. */
	.wall.left {
		clip-path: polygon(0 0, 16% 16%, 16% 84%, 0 100%);
		background: linear-gradient(90deg, #0c0907, #231b11);
	}

	.wall.right {
		clip-path: polygon(100% 0, 100% 100%, 84% 84%, 84% 16%);
		background: linear-gradient(90deg, #231b11, #0c0907);
	}

	/* Warm spotlight on the back wall, behind the floating pack. */
	.glow {
		position: absolute;
		inset: 26% 28%;
		background: radial-gradient(ellipse at 50% 44%, rgba(255, 152, 31, 0.16), transparent 70%);
		filter: blur(6px);
	}
</style>
