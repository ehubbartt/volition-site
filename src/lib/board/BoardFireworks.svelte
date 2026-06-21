<script lang="ts">
	// Celebratory fireworks overlay (canvas). Click-through (pointer-events:none) and drawn on
	// a transparent canvas so the board / congrats card stays visible behind it. Either runs for
	// `duration` then calls oncomplete (a boss kill → advance to the next floor), or `loop`s
	// until unmounted (the final "completed" screen). Honours prefers-reduced-motion.
	import { onMount } from 'svelte';

	interface Props {
		duration?: number;
		loop?: boolean;
		oncomplete?: () => void;
	}

	let { duration = 4200, loop = false, oncomplete }: Props = $props();

	let canvas: HTMLCanvasElement;

	onMount(() => {
		const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches ?? false;
		const ctx = canvas.getContext('2d');
		if (!ctx) {
			if (!loop) oncomplete?.();
			return;
		}

		// Reduced motion: skip the animation. Finite runs still resolve (after a beat) so the
		// next-floor advance proceeds; looping (congrats) just shows nothing behind the card.
		if (reduce) {
			if (!loop) {
				const id = setTimeout(() => oncomplete?.(), 650);
				return () => clearTimeout(id);
			}
			return () => {};
		}

		const COLORS = ['#ff981f', '#ffd24a', '#4ade80', '#60a5fa', '#f472b6', '#f87171', '#c084fc'];
		const dpr = Math.min(window.devicePixelRatio || 1, 2);
		let W = 0;
		let H = 0;

		function resize() {
			W = canvas.clientWidth;
			H = canvas.clientHeight;
			canvas.width = Math.floor(W * dpr);
			canvas.height = Math.floor(H * dpr);
			ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);
		}
		resize();
		window.addEventListener('resize', resize);

		interface P {
			x: number;
			y: number;
			vx: number;
			vy: number;
			life: number;
			max: number;
			color: string;
			size: number;
		}
		let parts: P[] = [];

		function burst(cx: number, cy: number) {
			const base = COLORS[Math.floor(Math.random() * COLORS.length)];
			const n = 56 + Math.floor(Math.random() * 46);
			for (let i = 0; i < n; i++) {
				const a = (Math.PI * 2 * i) / n + Math.random() * 0.35;
				const sp = 1.4 + Math.random() * 3.6;
				parts.push({
					x: cx,
					y: cy,
					vx: Math.cos(a) * sp,
					vy: Math.sin(a) * sp,
					life: 0,
					max: 55 + Math.random() * 45,
					color: Math.random() < 0.18 ? '#ffffff' : base,
					size: 1.4 + Math.random() * 1.8
				});
			}
		}

		const start = performance.now();
		let lastBurst = 0;
		let raf = 0;
		let running = true;

		function frame(t: number) {
			if (!running) return;
			ctx!.clearRect(0, 0, W, H);
			ctx!.globalCompositeOperation = 'lighter';

			const elapsed = t - start;
			const spawning = loop || elapsed < duration - 900;
			if (spawning && t - lastBurst > 240 + Math.random() * 260) {
				lastBurst = t;
				burst(W * (0.12 + Math.random() * 0.76), H * (0.12 + Math.random() * 0.5));
			}

			for (const p of parts) {
				p.life++;
				p.vy += 0.035; // gravity
				p.vx *= 0.99;
				p.vy *= 0.99;
				p.x += p.vx;
				p.y += p.vy;
				const k = 1 - p.life / p.max;
				if (k <= 0) continue;
				ctx!.globalAlpha = Math.max(0, k);
				ctx!.strokeStyle = p.color;
				ctx!.lineWidth = p.size;
				ctx!.lineCap = 'round';
				ctx!.beginPath();
				ctx!.moveTo(p.x - p.vx * 2.4, p.y - p.vy * 2.4);
				ctx!.lineTo(p.x, p.y);
				ctx!.stroke();
			}
			ctx!.globalAlpha = 1;
			ctx!.globalCompositeOperation = 'source-over';
			parts = parts.filter((p) => p.life < p.max);

			if (!loop && elapsed >= duration && parts.length === 0) {
				running = false;
				oncomplete?.();
				return;
			}
			raf = requestAnimationFrame(frame);
		}

		raf = requestAnimationFrame(frame);
		return () => {
			running = false;
			cancelAnimationFrame(raf);
			window.removeEventListener('resize', resize);
		};
	});
</script>

<canvas bind:this={canvas} class="fireworks" aria-hidden="true"></canvas>

<style>
	.fireworks {
		position: fixed;
		inset: 0;
		width: 100%;
		height: 100%;
		z-index: 210;
		pointer-events: none;
	}
</style>
