<script lang="ts">
	import { RARITY_BY_KEY, DEFAULT_RARITY, DEFAULT_CARD_BACK, type Card } from '$lib/cards/rarity';
	import { FINISH_BY_KEY, type CardFinish } from '$lib/cards/finishes';
	import { isVideoUrl } from '$lib/cards/config';

	let {
		card,
		quantity = null,
		finish = null,
		flip = true,
		backOnly = false
	}: {
		card: Card;
		quantity?: number | null;
		finish?: CardFinish | null;
		flip?: boolean;
		// backOnly: show only the card back (front art hidden) inside a rarity-colored
		// border — used for un-collected cards below SR in the collection.
		backOnly?: boolean;
	} = $props();

	let rarity = $derived(RARITY_BY_KEY[card.rarity] ?? RARITY_BY_KEY[DEFAULT_RARITY]);
	let finishMeta = $derived(finish ? FINISH_BY_KEY[finish] : null);
	let isHolo = $derived(!!finishMeta && finishMeta.key !== 'normal');
	let front = $derived(card.front_url || DEFAULT_CARD_BACK);
	let back = $derived(card.back_url || DEFAULT_CARD_BACK);
	let hidden = $derived(!!card.hidden);
</script>

{#if backOnly || hidden}
	<!-- Un-collected card: show only the (greyed) card back inside a rarity-colored
	     border. SR cards (`hidden`) come in redacted — name '???', no back_url → the
	     default back — so this hides their identity while still showing a card back. -->
	<div
		class="card-thumb no-flip back-only"
		style="--rarity: {rarity.color}"
		title={hidden ? 'Secret rare — pull it to reveal' : 'Undiscovered — not collected yet'}
	>
		<div class="art">
			<div class="face back static">
				<img src={back} alt="" loading="lazy" />
			</div>
		</div>
		<div class="info">
			<span class="name">???</span>
			<span class="rarity">{rarity.label}</span>
		</div>
	</div>
{:else}
	<div class="card-thumb" class:no-flip={!flip} style="--rarity: {rarity.color}" title={card.name}>
		<div class="art">
			<div class="flip">
				<div class="face front">
					{#if isVideoUrl(front)}
						<!-- svelte-ignore a11y_media_has_caption -->
						<video src={front} autoplay loop muted playsinline></video>
					{:else}
						<img src={front} alt={card.name} loading="lazy" />
					{/if}
					{#each card.layers ?? [] as ly}
						<img class="layer" src={ly.url} alt="" loading="lazy" />
					{/each}
				</div>
				<div class="face back">
					<img src={back} alt="" loading="lazy" />
				</div>
			</div>
			{#if quantity && quantity > 1}
				<span class="qty">×{quantity}</span>
			{/if}
			{#if isHolo}
				<span class="finish-badge">{finishMeta?.label}</span>
			{/if}
		</div>
		<div class="info">
			<span class="name">{card.name}</span>
			<span class="rarity">{rarity.label}{#if card.level} · lvl {card.level}{/if}</span>
		</div>
	</div>
{/if}

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

	.card-thumb.no-flip:hover .flip {
		transform: none;
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

	/* Static back (backOnly mode): face the viewer directly, un-mirrored. */
	.face.back.static {
		transform: none;
	}

	/* Un-collected slot: keep the rarity border bright, but grey the card back so it's
	   obvious at a glance which cards you actually own vs. which are just backs. */
	.card-thumb.back-only {
		border-width: 2px;
	}

	.card-thumb.back-only .art img {
		filter: grayscale(0.6) brightness(0.55);
	}

	.face img,
	.face video {
		width: 100%;
		height: 100%;
		object-fit: cover;
		image-rendering: -webkit-optimize-contrast;
	}

	/* Flat composite: depth layers stacked over the front (in order, last on top).
	   Same object-fit so they line up with the front art. */
	.face.front .layer {
		position: absolute;
		inset: 0;
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

	.finish-badge {
		position: absolute;
		top: 0.35rem;
		left: 0.35rem;
		z-index: 1;
		padding: 0.08rem 0.4rem;
		background: rgba(20, 8, 30, 0.85);
		border: 1px solid #b06bff;
		border-radius: 3px;
		font-size: 0.65rem;
		color: #e7d3ff;
		text-shadow: var(--ts);
		white-space: nowrap;
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
