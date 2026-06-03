<script lang="ts">
	import { RARITY_BY_KEY, DEFAULT_CARD_BACK, type Card } from '$lib/cards/rarity';

	let {
		card,
		quantity = null
	}: { card: Card; quantity?: number | null } = $props();

	let rarity = $derived(RARITY_BY_KEY[card.rarity] ?? RARITY_BY_KEY.common);
	let front = $derived(card.front_url || DEFAULT_CARD_BACK);
	let back = $derived(card.back_url || DEFAULT_CARD_BACK);
</script>

<div class="card-thumb" style="--rarity: {rarity.color}" title={card.name}>
	<div class="art">
		<div class="flip">
			<div class="face front">
				<img src={front} alt={card.name} loading="lazy" />
			</div>
			<div class="face back">
				<img src={back} alt="" loading="lazy" />
			</div>
		</div>
		{#if quantity && quantity > 1}
			<span class="qty">×{quantity}</span>
		{/if}
	</div>
	<div class="info">
		<span class="name">{card.name}</span>
		<span class="rarity">{rarity.label}{#if card.level} · lvl {card.level}{/if}</span>
	</div>
</div>

<style>
	.card-thumb {
		display: flex;
		flex-direction: column;
		background: var(--surface-alt);
		border: 1px solid var(--rarity);
		border-radius: var(--radius-lg);
		overflow: hidden;
		box-shadow:
			inset 0 0 0 1px rgba(0, 0, 0, 0.4),
			0 4px 12px rgba(0, 0, 0, 0.35);
		transition: transform 0.15s, box-shadow 0.15s;
	}

	.card-thumb:hover {
		transform: translateY(-3px);
		box-shadow:
			inset 0 0 0 1px var(--rarity),
			0 8px 20px rgba(0, 0, 0, 0.5);
	}

	.art {
		position: relative;
		aspect-ratio: 5 / 7;
		background: #000;
		perspective: 900px;
	}

	.flip {
		position: absolute;
		inset: 0;
		transform-style: preserve-3d;
		transition: transform 0.5s ease;
	}

	.card-thumb:hover .flip {
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

	.face.back {
		transform: rotateY(180deg);
	}

	.face img {
		width: 100%;
		height: 100%;
		object-fit: cover;
		image-rendering: -webkit-optimize-contrast;
	}

	.qty {
		position: absolute;
		bottom: 0.35rem;
		right: 0.35rem;
		z-index: 1;
		padding: 0.1rem 0.4rem;
		background: rgba(0, 0, 0, 0.8);
		border: 1px solid var(--rarity);
		border-radius: 999px;
		font-size: 0.8rem;
		color: var(--text);
		text-shadow: var(--ts);
	}

	.info {
		display: flex;
		flex-direction: column;
		gap: 0.1rem;
		padding: 0.4rem 0.5rem 0.5rem;
		border-top: 1px solid rgba(0, 0, 0, 0.4);
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

	@media (prefers-reduced-motion: reduce) {
		.flip {
			transition: none;
		}
	}
</style>
