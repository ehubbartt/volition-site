<script lang="ts">
	// Reusable loot-crate reveal: the CSGO-style spinning reel that lands on the won
	// reward, with per-cell tick/tock (or the slot-machine clip) audio. Extracted from
	// the gamba page so onboarding — and anywhere else — opens a crate with the SAME
	// animation. Set `reward` (non-null) to spin; `reel` is the filler-cell pool (every
	// possible reward bucket); `onClose` fires when the player dismisses the result.
	import { tick } from 'svelte';
	import { SFX_CRATE_SPIN, SFX_TICK, SFX_TOCK } from '$lib/cards/sfx';

	export interface CrateReward {
		kind: 'vp' | 'item' | 'role';
		amount: number;
		itemName: string | null;
		label: string;
		title: string;
		image: string;
		colorHex: string;
		chance: number;
	}
	interface ReelCell {
		label: string;
		image: string | null;
		colorHex: string;
	}

	let {
		reward,
		reel = [],
		onClose
	}: { reward: CrateReward | null; reel?: ReelCell[]; onClose: () => void } = $props();

	const CELL_W = 96;
	const CELL_GAP = 10;
	const STRIDE = CELL_W + CELL_GAP;
	const STRIP_LEN = 64;
	const SPIN_MS = 4700;

	// ── audio ────────────────────────────────────────────────────────────────
	let crateAudio: HTMLAudioElement | null = null;
	function crateVolume(): number {
		try {
			const v = parseFloat(localStorage.getItem('vs_po_volume') ?? '1');
			return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 1;
		} catch {
			return 1;
		}
	}
	function ensureCrateAudio(): HTMLAudioElement | null {
		if (typeof Audio === 'undefined') return null;
		if (!crateAudio) {
			crateAudio = new Audio(SFX_CRATE_SPIN);
			crateAudio.preload = 'auto';
			try {
				crateAudio.load();
			} catch {
				/* ignore */
			}
		}
		return crateAudio;
	}
	function playCrateSpin() {
		const a = ensureCrateAudio();
		if (!a) return;
		const vol = crateVolume();
		if (vol <= 0) return;
		try {
			a.muted = false;
			a.volume = vol;
			a.currentTime = 0;
			void a.play().catch(() => {});
		} catch {
			/* ignore */
		}
	}
	function stopCrateSpin() {
		if (crateAudio) {
			try {
				crateAudio.pause();
				crateAudio.currentTime = 0;
			} catch {
				/* ignore */
			}
		}
	}

	type ClickPool = { available: () => boolean; play: (v: number) => void; stop: () => void };
	function makeClickPool(url: string, size = 5): ClickPool {
		if (typeof Audio === 'undefined') return { available: () => false, play() {}, stop() {} };
		let errored = false;
		const pool: HTMLAudioElement[] = [];
		for (let i = 0; i < size; i++) {
			const a = new Audio(url);
			a.preload = 'auto';
			a.addEventListener('error', () => (errored = true), { once: true });
			try {
				a.load();
			} catch {
				/* ignore */
			}
			pool.push(a);
		}
		let idx = 0;
		return {
			available: () => !errored,
			play: (v) => {
				const a = pool[idx];
				idx = (idx + 1) % size;
				try {
					a.muted = false;
					a.volume = v;
					a.currentTime = 0;
					void a.play().catch(() => {});
				} catch {
					/* ignore */
				}
			},
			stop: () => {
				for (const a of pool) {
					try {
						a.pause();
						a.currentTime = 0;
					} catch {
						/* ignore */
					}
				}
			}
		};
	}
	let tickPool: ClickPool | null = null;
	let tockPool: ClickPool | null = null;
	let tickRaf = 0;
	function ensureClicks() {
		if (!tickPool) tickPool = makeClickPool(SFX_TICK);
		if (!tockPool) tockPool = makeClickPool(SFX_TOCK);
	}
	function clicksAvailable(): boolean {
		ensureClicks();
		return !!(tickPool?.available() && tockPool?.available());
	}
	function startTickLoop() {
		const el = stripEl;
		const vol = crateVolume();
		if (!el || vol <= 0) return;
		ensureClicks();
		const half = (el.parentElement?.clientWidth || el.clientWidth || 320) / 2;
		let lastEdge = Math.floor(half / STRIDE);
		let toggle = false;
		let lastAt = 0;
		const loop = (now: number) => {
			if (!crateSpinning) return;
			let tx = 0;
			try {
				const t = getComputedStyle(el).transform;
				if (t && t !== 'none') tx = new DOMMatrix(t).m41;
			} catch {
				/* ignore */
			}
			const edge = Math.floor((half - tx) / STRIDE);
			if (edge > lastEdge) {
				lastEdge = edge;
				if (now - lastAt >= 28) {
					lastAt = now;
					(toggle ? tockPool : tickPool)?.play(vol);
					toggle = !toggle;
				}
			}
			tickRaf = requestAnimationFrame(loop);
		};
		tickRaf = requestAnimationFrame(loop);
	}
	function stopTickLoop() {
		if (tickRaf) {
			cancelAnimationFrame(tickRaf);
			tickRaf = 0;
		}
		tickPool?.stop();
		tockPool?.stop();
	}

	// ── reel ─────────────────────────────────────────────────────────────────
	let crateStrip = $state<ReelCell[]>([]);
	let winIndex = $state(0);
	let crateSpinning = $state(false);
	let crateLanded = $state(false);
	let stripEl = $state<HTMLDivElement | undefined>();
	let spinTimer: ReturnType<typeof setTimeout> | null = null;
	let spinAnim: Animation | null = null;

	function rewardCell(r: CrateReward): ReelCell {
		return { label: r.kind === 'item' ? (r.itemName ?? r.label) : r.label, image: r.image || null, colorHex: r.colorHex };
	}
	function randomCell(): ReelCell {
		if (!reel.length) return { label: '?', image: null, colorHex: '#9a8c78' };
		return reel[Math.floor(Math.random() * reel.length)];
	}
	function nextFrame(): Promise<void> {
		return new Promise((r) => requestAnimationFrame(() => r()));
	}

	async function startSpin(r: CrateReward) {
		if (spinTimer) clearTimeout(spinTimer);
		if (spinAnim) {
			spinAnim.cancel();
			spinAnim = null;
		}
		stopCrateSpin();
		stopTickLoop();
		winIndex = STRIP_LEN - 8;
		crateStrip = Array.from({ length: STRIP_LEN }, (_, i) => (i === winIndex ? rewardCell(r) : randomCell()));
		crateLanded = false;
		crateSpinning = true;
		spinTimer = setTimeout(land, SPIN_MS + 1000);
		try {
			await tick();
			await nextFrame();
			const el = stripEl;
			if (!el) return;
			const vw = el.parentElement?.clientWidth || el.clientWidth || 320;
			const jitter = (Math.random() * 2 - 1) * (CELL_W * 0.3);
			const target = vw / 2 - (winIndex * STRIDE + CELL_W / 2) + jitter;
			const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
			const dur = reduce ? 1500 : SPIN_MS;
			if (typeof el.animate === 'function') {
				if (!reduce) {
					if (clicksAvailable()) startTickLoop();
					else playCrateSpin();
				}
				spinAnim = el.animate([{ transform: 'translateX(0px)' }, { transform: `translateX(${target}px)` }], {
					duration: dur,
					easing: 'cubic-bezier(0.05, 0.8, 0.15, 1)',
					fill: 'forwards'
				});
				spinAnim.onfinish = () => land();
			} else {
				el.style.transform = `translateX(${target}px)`;
				land();
			}
		} catch {
			land();
		}
	}
	function land() {
		if (spinTimer) {
			clearTimeout(spinTimer);
			spinTimer = null;
		}
		if (crateLanded) return;
		crateSpinning = false;
		crateLanded = true;
		stopTickLoop();
	}
	function close() {
		if (spinTimer) clearTimeout(spinTimer);
		spinTimer = null;
		if (spinAnim) {
			spinAnim.cancel();
			spinAnim = null;
		}
		stopCrateSpin();
		stopTickLoop();
		crateSpinning = false;
		crateLanded = false;
		crateStrip = [];
		onClose();
	}
	function pct(n: number): string {
		return n < 1 ? n.toFixed(2) : n.toFixed(1);
	}

	// Start spinning whenever a fresh reward is handed in.
	let startedFor: CrateReward | null = null;
	$effect(() => {
		if (reward && reward !== startedFor) {
			startedFor = reward;
			void startSpin(reward);
		}
	});
</script>

{#if reward}
	<div class="reveal-wrap">
		<button class="reveal-backdrop" aria-label="Close" onclick={close}></button>
		<div class="reveal" role="dialog" aria-modal="true" tabindex="-1" style="--c:{reward.colorHex}">
			<div class="reel-viewport">
				<div class="reel-marker"></div>
				<div class="reel-strip" bind:this={stripEl}>
					{#each crateStrip as cell, i (i)}
						<div class="reel-cell" class:win={crateLanded && i === winIndex} style="--cc:{cell.colorHex}">
							{#if cell.image}
								<img src={cell.image} alt="" loading="lazy" decoding="async" />
							{:else}
								<span class="reel-text">{cell.label}</span>
							{/if}
						</div>
					{/each}
				</div>
				<div class="reel-fade"></div>
			</div>

			{#if crateLanded}
				<div class="reveal-burst"></div>
				<h3 class="reveal-title">{reward.title}</h3>
				<p class="reveal-detail">
					{#if reward.kind === 'vp'}
						{reward.amount > 0 ? `+${reward.amount} VP` : 'Nothing this time'}
					{:else if reward.kind === 'item'}
						{reward.itemName}
					{:else}
						King Gamba — assigned in Discord shortly
					{/if}
				</p>
				<span class="reveal-chance">{reward.label} · {pct(reward.chance)}%</span>
				<button type="button" class="primary reveal-close" onclick={close}>Nice</button>
			{:else}
				<p class="reveal-spinning">Opening…</p>
			{/if}
		</div>
	</div>
{/if}

<style>
	.reveal-wrap {
		position: fixed;
		inset: 0;
		z-index: 100;
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		place-items: center;
		padding: 1rem;
	}
	.reveal-backdrop {
		position: absolute;
		inset: 0;
		width: 100%;
		height: 100%;
		min-height: 0;
		padding: 0;
		border: none;
		border-radius: 0;
		background: rgba(0, 0, 0, 0.72);
		cursor: pointer;
	}
	.reveal {
		position: relative;
		z-index: 1;
		width: min(32rem, 100%);
		max-width: 32rem;
		min-width: 0;
		overflow: hidden;
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 0.5rem;
		padding: 1.6rem 1.5rem;
		text-align: center;
		background: linear-gradient(180deg, rgba(48, 40, 30, 0.98), rgba(30, 24, 18, 0.98));
		border: 1px solid var(--c);
		border-radius: var(--radius-lg);
		box-shadow: 0 0 2.5rem -0.5rem var(--c);
		animation: reveal-pop 0.32s cubic-bezier(0.2, 1.3, 0.5, 1);
	}
	@keyframes reveal-pop {
		from { transform: scale(0.6); opacity: 0; }
		to { transform: scale(1); opacity: 1; }
	}
	.reveal-burst {
		position: absolute;
		top: 4.5rem;
		width: 12rem;
		height: 12rem;
		border-radius: 50%;
		background: radial-gradient(circle, color-mix(in srgb, var(--c) 55%, transparent), transparent 65%);
		pointer-events: none;
		animation: burst 0.6s ease-out forwards;
	}
	@keyframes burst {
		from { transform: scale(0.2); opacity: 0.9; }
		to { transform: scale(1.4); opacity: 0; }
	}
	.reel-viewport {
		position: relative;
		width: 100%;
		height: 116px;
		margin-bottom: 0.4rem;
		overflow: hidden;
		background: #0d0a07;
		border: 1px solid var(--border);
		border-radius: var(--radius);
	}
	.reel-strip { display: flex; gap: 10px; align-items: center; height: 100%; will-change: transform; }
	.reel-cell {
		flex: 0 0 96px;
		width: 96px;
		height: 96px;
		display: flex;
		align-items: center;
		justify-content: center;
		border-radius: 6px;
		border: 1px solid color-mix(in srgb, var(--cc) 50%, #2a2018);
		background: linear-gradient(180deg, color-mix(in srgb, var(--cc) 28%, #2a2018), #14100a);
		box-shadow: inset 0 0 10px rgba(0, 0, 0, 0.45);
		transition: transform 0.25s ease, box-shadow 0.25s ease;
	}
	.reel-cell img { width: 74%; height: 74%; object-fit: contain; }
	.reel-text {
		font-family: var(--font-heading);
		font-size: 0.78rem;
		text-align: center;
		line-height: 1.15;
		padding: 0 4px;
		color: var(--cc);
		text-shadow: var(--ts);
	}
	.reel-cell.win {
		border-color: var(--cc);
		box-shadow: 0 0 14px var(--cc), inset 0 0 0 1px var(--cc);
		transform: scale(1.06);
	}
	.reel-marker {
		position: absolute;
		top: -2px;
		bottom: -2px;
		left: 50%;
		width: 2px;
		transform: translateX(-50%);
		background: var(--accent);
		box-shadow: 0 0 8px var(--accent);
		z-index: 2;
	}
	.reel-marker::before, .reel-marker::after {
		content: '';
		position: absolute;
		left: 50%;
		transform: translateX(-50%);
		border-left: 6px solid transparent;
		border-right: 6px solid transparent;
	}
	.reel-marker::before { top: -1px; border-top: 7px solid var(--accent); }
	.reel-marker::after { bottom: -1px; border-bottom: 7px solid var(--accent); }
	.reel-fade {
		position: absolute;
		inset: 0;
		z-index: 1;
		pointer-events: none;
		background: linear-gradient(90deg, #0d0a07 0%, transparent 14%, transparent 86%, #0d0a07 100%);
	}
	.reveal-spinning { margin: 0; color: var(--muted); font-family: var(--font-heading); letter-spacing: 1px; }
	.reveal-title { margin: 0; color: var(--c); text-shadow: var(--ts); }
	.reveal-detail { margin: 0; font-family: var(--font-heading); font-size: 1.3rem; }
	.reveal-chance { font-size: 0.8rem; color: var(--muted); }
	.reveal-close { margin-top: 0.6rem; border-color: var(--accent); }
</style>
