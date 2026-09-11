<script lang="ts">
	// The row of objectives above the board — one card per column, showing the drop that
	// claims it. Rendered as a grid on the SAME column tracks as the board (same `--n`,
	// same `--gap`, same min-width), so every card sits exactly over the column it feeds.
	//
	// At 25 columns a card is ~45px wide, which is room for the item's icon and nothing
	// else. The name lives in the detail strip the parent shows for the selected column —
	// trying to fit it here produces 25 unreadable slivers.
	import WikiImage from '$lib/WikiImage.svelte';
	import { itemImageUrl, nameInitials } from '$lib/wikiImage';
	import { columnLabel, type LiveTile } from './rules';

	let {
		live = [],
		claiming,
		selected = null,
		freshCols,
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
		/**
		 * Columns whose objective went up in the last few minutes. Flagged on the token
		 * itself: a 40-column rail changes a tile at a time and nothing about a replacement
		 * looked different from the tile that had been sitting there for an hour.
		 */
		freshCols?: Set<number>;
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

<!-- Its own row above the tokens, on the SAME column tracks as the rail and the board
     below it — a label inside the token covered the art it was pointing at. Rendered only
     when something is actually new, so the board is not carrying an empty strip all
     evening. -->
{#if freshCols?.size}
	<div class="newrow" aria-hidden="true">
		{#each live as _slot, col (col)}
			<span class:on={freshCols.has(col)}>{freshCols.has(col) ? 'NEW' : ''}</span>
		{/each}
	</div>
{/if}

<div class="rail">
	{#each live as slot, col (col)}
		<button
			type="button"
			class="tile"
			class:retired={!slot}
			class:claiming={claiming?.has(col)}
			class:selected={selected === col}
			title={slot
				? `${columnLabel(col)} — ${slot.tile.item_name}${slot.tile.source ? ` (${slot.tile.source})` : ''}${slot.tile.pre_shot ? ' — NEEDS A BEFORE SCREENSHOT' : ''}`
				: `${columnLabel(col)} — column full`}
			aria-label={slot ? `Column ${columnLabel(col)}: ${slot.tile.item_name}` : `Column ${columnLabel(col)} is full`}
			onclick={() => onselect?.(col)}
			onmouseenter={(e) => report(e, slot)}
			onfocus={(e) => report(e, slot)}
			onmouseleave={() => onhover?.(null)}
			onblur={() => onhover?.(null)}
		>
			{#if slot}
				<span class="disc">
					<!-- The token above the board is the thing a player reads at a glance, so it
					     never renders as an empty disc: a name with no wiki file falls back to
					     its initials. -->
					<WikiImage
						src={itemImageUrl(slot.tile.any_of?.[0]?.item_name ?? slot.tile.item_name)}
						alt=""
						size={28}
						fallback={nameInitials(slot.tile.item_name)}
					/>
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
	.newrow {
		display: grid;
		grid-template-columns: repeat(var(--n), minmax(0, 1fr));
		gap: var(--gap);
		min-width: calc(var(--n) * (var(--min-cell) + var(--gap)));
		line-height: 1;
	}
	.newrow span {
		display: block;
		min-width: 0;
		overflow: hidden;
		text-align: center;
		/* Tracks the column like the labels do, with a floor so 40 columns stay legible. */
		font-size: clamp(6px, calc(30rem / var(--n) / 3), 0.68rem);
		font-weight: 700;
		letter-spacing: 0.02em;
		color: #ff4d4d;
		text-shadow: 0 1px 2px #000;
	}
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
		/* So the initials stand-in can be sized against the card rather than against a
		   fixed pixel number — on a zoomed board the disc grows and it has to come with
		   it, and more than half this board's tiles have no wiki file to draw. */
		container-type: inline-size;
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
	/* WikiImage sizes its stand-in off the `size` prop, which is one number for every
	   column. Track the card instead, exactly as the art above does. */
	.disc :global(.wiki-fallback) {
		width: 88cqw;
		height: 88cqw;
		font-size: 36cqw;
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
