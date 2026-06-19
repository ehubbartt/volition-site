<script lang="ts">
	// Shown once a team defeats the FINAL boss — the DuoWolf climb is complete. Fireworks
	// (rendered by the parent, looping) burst over this card until it's dismissed.
	interface Props {
		eventName: string;
		onclose: () => void;
	}

	let { eventName, onclose }: Props = $props();

	function onKey(e: KeyboardEvent) {
		if (e.key === 'Escape') onclose();
	}
</script>

<svelte:window onkeydown={onKey} />

<div class="backdrop">
	<div class="card" role="dialog" aria-modal="true" aria-labelledby="complete-title">
		<div class="trophy" aria-hidden="true">🏆</div>
		<p class="kicker">{eventName}</p>
		<h2 id="complete-title">Congratulations on completing Duo Wolf!</h2>
		<p class="sub">
			Your team climbed all the way to the top and defeated the final boss. Incredible run —
			enjoy the glory! 🐺
		</p>
		<button type="button" class="primary" onclick={onclose}>Continue</button>
	</div>
</div>

<style>
	.backdrop {
		position: fixed;
		inset: 0;
		background: radial-gradient(ellipse at 50% 40%, rgba(60, 40, 20, 0.75), rgba(0, 0, 0, 0.88));
		z-index: 200;
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 2rem 1rem;
		overflow-y: auto;
	}

	.card {
		position: relative;
		margin: auto;
		width: 100%;
		max-width: 32rem;
		padding: 2rem 1.75rem;
		text-align: center;
		background: linear-gradient(180deg, rgba(58, 48, 36, 0.98), rgba(40, 32, 24, 0.98));
		border: 1px solid var(--accent);
		border-radius: var(--radius);
		box-shadow: 0 0 60px rgba(255, 152, 31, 0.35), var(--shadow-card);
		color: var(--text);
		font-family: var(--font-body);
		animation: pop 0.4s ease-out;
	}

	@keyframes pop {
		from {
			transform: scale(0.9);
			opacity: 0;
		}
		to {
			transform: scale(1);
			opacity: 1;
		}
	}

	.trophy {
		font-size: 4rem;
		line-height: 1;
		filter: drop-shadow(0 4px 10px rgba(0, 0, 0, 0.6));
		animation: bob 2.4s ease-in-out infinite;
	}

	@keyframes bob {
		0%,
		100% {
			transform: translateY(0) rotate(-4deg);
		}
		50% {
			transform: translateY(-8px) rotate(4deg);
		}
	}

	.kicker {
		margin: 0.75rem 0 0.25rem;
		font-family: var(--font-heading);
		font-size: 0.78rem;
		letter-spacing: 2px;
		text-transform: uppercase;
		color: var(--muted);
	}

	h2 {
		margin: 0 0 0.6rem;
		font-size: 1.7rem;
		color: var(--accent);
		text-shadow: var(--ts-strong);
		line-height: 1.15;
	}

	.sub {
		margin: 0 0 1.5rem;
		color: var(--text);
		line-height: 1.5;
	}

	button.primary {
		font-family: var(--font-heading);
		letter-spacing: 1px;
		padding: 0.6rem 1.6rem;
		border-color: var(--accent);
	}

	button.primary:hover {
		background: var(--accent-soft);
	}

	@media (prefers-reduced-motion: reduce) {
		.card,
		.trophy {
			animation: none;
		}
	}
</style>
