<script lang="ts">
	// The row of objectives above the board — one card per column, showing the drop that
	// claims it. Rendered as a grid on the SAME column tracks as the board (same `--n`,
	// same `--gap`, same min-width), so every card sits exactly over the column it feeds.
	//
	// At 25 columns a card is ~45px wide, which is room for the item's icon and nothing
	// else. The name lives in the detail strip the parent shows for the selected column —
	// trying to fit it here produces 25 unreadable slivers.
	import WikiImage from '$lib/WikiImage.svelte';
	import { itemImageUrl } from '$lib/wikiImage';
	import { columnLabel, type LiveTile } from './rules';

	let {
		live = [],
		claiming,
		selected = null,
		onselect,
		onhover
	}: {
		live: (LiveTile | null)[];
		/**
		 * Columns whose objective has been claimed but whose replacement the server has not
		 * named yet. Shown as spent rather than as the tile that was just won — otherwise the
		 * rail reads as though the click did nothing.
		 */
		claiming?: Set<number>;
		selected?: number | null;
		onselect?: (col: number) => void;
		/** Reports the pointed-at objective (and where it is) so the board can card it. */
		onhover?: (info: { slot: LiveTile; x: number; y: number } | null) => void;
	} = $props();

	function report(e: MouseEvent | FocusEvent, slot: LiveTile | null) {
		if (!slot) return onhover?.(null);
		const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
		onhover?.({ slot, x: r.left + r.width / 2, y: r.top });
	}
</script>

<div class="rail">
	{#each live as slot, col (col)}
		<button
			type="button"
			class="tile"
			class:retired={!slot}
			class:claiming={claiming?.has(col)}
			class:selected={selected === col}
			title={slot ? `${columnLabel(col)} — ${slot.tile.item_name}${slot.tile.source ? ` (${slot.tile.source})` : ''}` : `${columnLabel(col)} — column full`}
			aria-label={slot ? `Column ${columnLabel(col)}: ${slot.tile.item_name}` : `Column ${columnLabel(col)} is full`}
			onclick={() => onselect?.(col)}
			onmouseenter={(e) => report(e, slot)}
			onfocus={(e) => report(e, slot)}
			onmouseleave={() => onhover?.(null)}
			onblur={() => onhover?.(null)}
		>
			{#if slot}
				<span class="disc">
					<WikiImage src={itemImageUrl(slot.tile.any_of?.[0]?.item_name ?? slot.tile.item_name)} alt="" size={28} />
				</span>
				{#if slot.tile.qty && slot.tile.qty > 1}
					<span class="qty-badge" aria-hidden="true">×{slot.tile.qty}</span>
				{/if}
				{#if claiming?.has(col)}<span class="dealing" aria-hidden="true"></span>{/if}
			{:else}
				<span class="done">✓</span>
			{/if}
		</button>
	{/each}
</div>

<style>
	.rail {
		display: grid;
		grid-template-columns: repeat(var(--n), minmax(0, 1fr));
		gap: var(--gap);
		min-width: calc(var(--n) * (var(--min-cell) + var(--gap)));
	}

	/* These are <button>s, so app.css's global bronze frame would force them 38px tall
	   and rectangular. Reset it, exactly as BoardGrid has to. */
	.tile {
		border-image: none;
		min-height: 0;
		margin: 0;
		/* No padding: the disc fills the square card, or it renders as a flat ellipse. */
		padding: 0;
		display: flex;
		align-items: center;
		justify-content: center;
		aspect-ratio: 1;
		/* The dealing sweep is an absolutely-positioned child of this card. */
		position: relative;
		overflow: hidden;
		background: linear-gradient(180deg, #3b3226 0%, #2a2419 100%);
		border: 1px solid var(--border);
		border-radius: 3px;
		cursor: pointer;
		transition:
			transform 0.1s ease-out,
			border-color 0.1s ease-out;
	}
	/* Claimed, replacement not yet named: the objective is spent, so it reads as spent —
	   dimmed under a sweep — rather than as a tile still up for grabs. */
	.tile.claiming .disc {
		opacity: 0.35;
		filter: saturate(0.4);
	}
	.tile.claiming .dealing {
		position: absolute;
		inset: 0;
		border-radius: inherit;
		background: linear-gradient(
			110deg,
			transparent 30%,
			color-mix(in srgb, var(--accent) 45%, transparent) 50%,
			transparent 70%
		);
		background-size: 260% 100%;
	}
	@media (prefers-reduced-motion: no-preference) {
		.tile.claiming .dealing {
			animation: c4-dealing 900ms linear infinite;
		}
	}
	@keyframes c4-dealing {
		from {
			background-position: 140% 0;
		}
		to {
			background-position: -40% 0;
		}
	}

	.tile:hover:not(.retired) {
		border-color: var(--accent);
		transform: translateY(-2px);
	}
	.tile.selected {
		border-color: var(--accent);
		box-shadow: 0 0 0 2px var(--accent-soft);
	}
	.tile.retired {
		background: linear-gradient(180deg, #241f18 0%, #1a1712 100%);
		opacity: 0.45;
		cursor: default;
	}

	/* A light disc behind the icon so dark wiki glyphs stay visible on the dark card. */
	.disc {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 100%;
		height: 100%;
		border-radius: 50%;
		background: radial-gradient(circle at 40% 35%, #efe4c8 0%, #cbbb95 75%, #a89774 100%);
		box-shadow: inset 0 0 4px rgba(0, 0, 0, 0.35);
		overflow: hidden;
	}
	.disc :global(img) {
		max-width: 80%;
		max-height: 80%;
		width: auto;
		height: auto;
		object-fit: contain;
	}
	.done {
		color: var(--success);
		font-size: 0.9rem;
	}
	/* Quantity marker, tucked in the corner so a 45px card stays an icon. */
	.qty-badge {
		position: absolute;
		right: 1px;
		bottom: 1px;
		font-size: 0.6rem;
		line-height: 1;
		padding: 0 0.15rem;
		border-radius: 3px;
		background: rgba(0, 0, 0, 0.65);
		color: var(--yellow, #eab308);
		pointer-events: none;
	}
</style>
