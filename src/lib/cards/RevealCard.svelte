<script lang="ts">
	import { RARITY_BY_KEY, DEFAULT_RARITY, DEFAULT_CARD_BACK, type Card } from '$lib/cards/rarity';

	let { card }: { card: Card } = $props();

	let revealed = $state(false);
	let rarity = $derived(RARITY_BY_KEY[card.rarity] ?? RARITY_BY_KEY[DEFAULT_RARITY]);
	let front = $derived(card.front_url || DEFAULT_CARD_BACK);
	let back = $derived(card.back_url || DEFAULT_CARD_BACK);
</script>

<button
	type="button"
	class="reveal"
	class:revealed
	style="--rarity: {rarity.color}"
	onclick={() => (revealed = !revealed)}
	aria-label={revealed ? card.name : 'Reveal card'}
>
	<div class="art">
		<div class="flip" class:show-front={revealed}>
			<div class="face cover">
				<img src={back} alt="" loading="lazy" />
			</div>
			<div class="face front">
				<img src={front} alt={card.name} loading="lazy" />
			</div>
		</div>
	</div>
	<div class="info">
		{#if revealed}
			<span class="name">{card.name}</span>
			<span class="rarity">{rarity.label}{#if card.level} · lvl {card.level}{/if}</span>
		{:else}
			<span class="hint">Click to reveal</span>
		{/if}
	</div>
</button>

<style>
	.reveal {
		display: flex;
		flex-direction: column;
		padding: 0;
		min-height: auto;
		background: var(--surface-alt);
		border: 1px solid var(--border);
		border-radius: var(--radius-lg);
		overflow: hidden;
		cursor: pointer;
		text-align: left;
		transition: border-color 0.15s, box-shadow 0.15s, transform 0.15s;
		box-shadow:
			inset 0 0 0 1px rgba(0, 0, 0, 0.4),
			0 4px 12px rgba(0, 0, 0, 0.35);
	}

	.reveal:hover {
		transform: translateY(-3px);
		border-color: var(--border-strong);
	}

	.reveal.revealed {
		border-color: var(--rarity);
		box-shadow:
			inset 0 0 0 1px var(--rarity),
			0 8px 20px rgba(0, 0, 0, 0.5);
	}

	.art {
		position: relative;
		aspect-ratio: 5 / 7;
		background: #000;
		perspective: 1000px;
	}

	.flip {
		position: absolute;
		inset: 0;
		transform-style: preserve-3d;
		transition: transform 0.55s ease;
	}

	.flip.show-front {
		transform: rotateY(180deg);
	}

	.face {
		position: absolute;
		inset: 0;
		backface-visibility: hidden;
		-webkit-backface-visibility: hidden;
		display: flex;
		align-items: center;
		justify-content: center;
	}

	.face.front {
		transform: rotateY(180deg);
	}

	.face img {
		width: 100%;
		height: 100%;
		object-fit: cover;
		image-rendering: -webkit-optimize-contrast;
	}

	.info {
		display: flex;
		flex-direction: column;
		gap: 0.1rem;
		padding: 0.4rem 0.5rem 0.5rem;
		border-top: 1px solid rgba(0, 0, 0, 0.4);
		min-height: 2.4rem;
	}

	.name {
		font-size: 0.9rem;
		color: var(--text);
		text-shadow: var(--ts);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.rarity {
		font-size: 0.75rem;
		color: var(--rarity);
		text-shadow: var(--ts);
	}

	.hint {
		font-size: 0.8rem;
		color: var(--muted);
		text-shadow: var(--ts);
	}

	@media (prefers-reduced-motion: reduce) {
		.flip {
			transition: none;
		}
	}
</style>
