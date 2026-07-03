<script lang="ts">
	import { DEFAULT_PACK_FRONT, DEFAULT_PACK_BACK, type CardPack } from '$lib/cards/packs';

	let {
		pack,
		quantity = null,
		flip = true
	}: { pack: CardPack; quantity?: number | null; flip?: boolean } = $props();

	let front = $derived(pack.front_url || DEFAULT_PACK_FRONT);
	let back = $derived(pack.back_url || DEFAULT_PACK_BACK);
</script>

<div class="pack-thumb" class:no-flip={!flip} title={pack.name}>
	<div class="art">
		<div class="flip">
			<div class="face front">
				<img src={front} alt={pack.name} loading="lazy" decoding="async" />
			</div>
			<div class="face back">
				<img src={back} alt="" loading="lazy" decoding="async" />
			</div>
		</div>
		{#if quantity && quantity > 1}
			<span class="qty">×{quantity}</span>
		{/if}
	</div>
	<div class="info">
		<span class="name">{pack.name}</span>
		{#if pack.cost_vp > 0}
			<span class="cost">{pack.cost_vp.toLocaleString()} VP</span>
		{/if}
	</div>
</div>

<style>
	.pack-thumb {
		display: flex;
		flex-direction: column;
		background: var(--surface-alt);
		border: 1px solid var(--accent);
		border-radius: var(--radius-lg);
		overflow: hidden;
		box-shadow:
			inset 0 0 0 1px rgba(0, 0, 0, 0.4),
			0 4px 12px rgba(0, 0, 0, 0.35);
		transition: transform 0.15s, box-shadow 0.15s;
	}

	.pack-thumb:hover {
		transform: translateY(-3px);
		box-shadow:
			inset 0 0 0 1px var(--accent),
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

	.pack-thumb:hover .flip {
		transform: rotateY(180deg);
	}

	.pack-thumb.no-flip:hover .flip {
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
		border: 1px solid var(--accent);
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

	.cost {
		font-size: 0.75rem;
		color: var(--accent);
		text-shadow: var(--ts);
	}

	@media (prefers-reduced-motion: reduce) {
		.flip {
			transition: none;
		}
	}
</style>
