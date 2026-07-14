<script lang="ts">
	import RankBadge from '$lib/RankBadge.svelte';
	import { rankLabel, rankColor } from '$lib/ranks';

	// Full-screen rank-up moment: confetti burst + the new rank badge punching in.
	// Purely presentational — the caller decides when a rank-up happened (the /me
	// checkRank action compares the saved rank before/after). Click, Escape, or the
	// 8s timer dismisses it; confetti is skipped under prefers-reduced-motion.
	let {
		from,
		to,
		onclose
	}: {
		from: string;
		to: string;
		onclose: () => void;
	} = $props();

	// One-shot confetti field: random positions/timings/colors baked at mount so the
	// pieces don't reshuffle on re-render (the caller remounts per rank-up, so the
	// initial-value capture of from/to is deliberate). Palette = golds + both ranks.
	// svelte-ignore state_referenced_locally
	const PALETTE = ['#ffd23b', '#ff981f', '#fff3c4', '#6aa84f', rankColor(from), rankColor(to)];
	const pieces = Array.from({ length: 120 }, (_, i) => ({
		id: i,
		x: Math.random() * 100, // vw
		delay: Math.random() * 2, // s
		duration: 2.6 + Math.random() * 2.4, // s
		size: 6 + Math.random() * 7, // px
		spin: (Math.random() > 0.5 ? 1 : -1) * (360 + Math.random() * 540), // deg
		sway: -6 + Math.random() * 12, // vw drift while falling
		color: PALETTE[Math.floor(Math.random() * PALETTE.length)],
		round: Math.random() > 0.7
	}));

	$effect(() => {
		const t = setTimeout(onclose, 8000);
		return () => clearTimeout(t);
	});
</script>

<svelte:window onkeydown={(e) => { if (e.key === 'Escape') onclose(); }} />

<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
<div class="overlay" onclick={onclose} role="presentation">
	{#each pieces as p (p.id)}
		<span
			class="confetti"
			class:round={p.round}
			style="--x:{p.x}vw; --delay:{p.delay}s; --dur:{p.duration}s; --size:{p.size}px; --spin:{p.spin}deg; --sway:{p.sway}vw; --c:{p.color}"
		></span>
	{/each}
	<div class="card">
		<span class="title">Rank up!</span>
		<div class="ranks">
			<div class="rank old">
				<RankBadge rank={from} size={44} />
				<span class="rname" style="color:{rankColor(from)}">{rankLabel(from)}</span>
			</div>
			<span class="arrow">➜</span>
			<div class="rank new">
				<RankBadge rank={to} size={88} />
				<span class="rname big" style="color:{rankColor(to)}">{rankLabel(to)}</span>
			</div>
		</div>
		<span class="hint muted">Click anywhere to continue</span>
	</div>
</div>

<style>
	.overlay {
		position: fixed;
		inset: 0;
		z-index: 200;
		display: flex;
		align-items: center;
		justify-content: center;
		background: rgba(0, 0, 0, 0.6);
		overflow: hidden;
		cursor: pointer;
		animation: fade-in 0.25s ease;
	}

	/* ── Confetti ── */
	.confetti {
		position: absolute;
		top: -4vh;
		left: var(--x);
		width: var(--size);
		height: calc(var(--size) * 0.45);
		background: var(--c);
		opacity: 0;
		animation: fall var(--dur) linear var(--delay) infinite;
	}
	.confetti.round {
		height: var(--size);
		border-radius: 50%;
	}
	@keyframes fall {
		0% {
			transform: translate(0, 0) rotate(0deg);
			opacity: 1;
		}
		100% {
			transform: translate(var(--sway), 108vh) rotate(var(--spin));
			opacity: 0.85;
		}
	}

	/* ── The card ── */
	.card {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 1.1rem;
		padding: 2rem 2.6rem;
		background: var(--surface-alt, #2a2418);
		border: 2px solid var(--accent, #ff981f);
		border-radius: 12px;
		box-shadow: 0 10px 44px rgba(0, 0, 0, 0.65);
		animation: punch-in 0.45s cubic-bezier(0.2, 1.6, 0.4, 1);
		cursor: default;
	}
	.title {
		font-family: var(--font-heading);
		font-size: 2rem;
		color: var(--accent, #ff981f);
		text-shadow: var(--ts, 1px 1px 0 #000);
		letter-spacing: 0.04em;
	}
	.ranks {
		display: flex;
		align-items: center;
		gap: 1.4rem;
	}
	.rank {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 0.4rem;
	}
	.rank.old {
		opacity: 0.55;
	}
	.rank.new {
		animation: glow-pulse 1.6s ease-in-out infinite;
	}
	.arrow {
		font-size: 1.6rem;
		color: var(--muted, #9aa0a6);
	}
	.rname {
		font-family: var(--font-heading);
		font-size: 0.95rem;
		text-shadow: var(--ts, 1px 1px 0 #000);
	}
	.rname.big {
		font-size: 1.35rem;
	}
	.hint {
		font-size: 0.78rem;
	}
	.muted {
		color: var(--muted, #9aa0a6);
	}

	@keyframes fade-in {
		from {
			opacity: 0;
		}
	}
	@keyframes punch-in {
		0% {
			transform: scale(0.5);
			opacity: 0;
		}
		100% {
			transform: scale(1);
			opacity: 1;
		}
	}
	@keyframes glow-pulse {
		0%,
		100% {
			filter: drop-shadow(0 0 6px rgba(255, 210, 59, 0.55));
		}
		50% {
			filter: drop-shadow(0 0 18px rgba(255, 210, 59, 0.95));
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.confetti {
			display: none;
		}
		.overlay,
		.card,
		.rank.new {
			animation: none;
		}
	}
</style>
