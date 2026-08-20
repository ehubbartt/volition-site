<script lang="ts">
	// The Connect Four board: 25 columns × 10 rows of holes in a slotted frame, with the
	// objectives rail sitting directly above the columns it feeds.
	//
	// Three things are load-bearing and easy to break:
	//
	//  - THE RAIL, THE LABELS AND THE BOARD ARE SEPARATE GRIDS SHARING ONE COLUMN TRACK
	//    DEFINITION (`--n`, `--gap`, the same min-width). That is what keeps a tile card
	//    exactly over its column at any width — three independently-sized grids would
	//    drift apart the moment one of them had different content.
	//  - ROW 0 IS THE BOTTOM. The rules number rows from the floor up because that is how
	//    gravity works; CSS grid numbers from the top down. The rendering loop counts down
	//    so the two never have to agree anywhere else.
	//  - CELLS ARE <button>s, so app.css's global bronze frame would force them 38px tall
	//    and rectangular. `border-image: none` and `min-height: 0` undo it, exactly as
	//    BoardGrid has to.
	import TileRail from './TileRail.svelte';
	import { COLS, ROWS, cellId, columnLabel, type LiveTile, type Piece, type Side } from './rules';

	let {
		pieces = [],
		live = [],
		sideColors = ['#ef4444', '#eab308'],
		sideNames = ['Red', 'Yellow'],
		runCells = new Set<string>(),
		newestCell = null,
		selected = null,
		onselect,
		oncolumn,
		disabled = false
	}: {
		pieces: Piece[];
		live: (LiveTile | null)[];
		sideColors?: string[];
		sideNames?: string[];
		/** Cells belonging to a scoring run — they glow. */
		runCells?: Set<string>;
		/** The most recent claim, which falls into place. */
		newestCell?: string | null;
		selected?: number | null;
		onselect?: (col: number) => void;
		/** Clicking a column (admin manual credit). Omit for a read-only board. */
		oncolumn?: (col: number) => void;
		disabled?: boolean;
	} = $props();

	const byCell = $derived(new Map(pieces.map((p) => [cellId(p.col, p.row), p])));

	// Top-down render order, so grid row 1 is the top of the board and row 0 is the floor.
	const rowsTopDown = $derived(Array.from({ length: ROWS }, (_, i) => ROWS - 1 - i));
	const cols = $derived(Array.from({ length: COLS }, (_, i) => i));

	const colFull = $derived(
		cols.map((c) => pieces.filter((p) => p.col === c).length >= ROWS)
	);
</script>

<div class="wrap" style="--n: {COLS}; --rows: {ROWS};">
	<TileRail {live} {selected} {onselect} />

	<div class="collabels" aria-hidden="true">
		{#each cols as c (c)}<span class:full={colFull[c]}>{columnLabel(c)}</span>{/each}
	</div>

	<div class="board" role="grid" aria-label="Connect Four board, {COLS} columns by {ROWS} rows">
		{#each rowsTopDown as row (row)}
			{#each cols as col (col)}
				{@const id = cellId(col, row)}
				{@const piece = byCell.get(id)}
				{@const inRun = runCells.has(id)}
				<button
					type="button"
					class="hole"
					class:filled={!!piece}
					class:in-run={inRun}
					class:newest={newestCell === id}
					style={piece
						? `--disc: ${sideColors[piece.side - 1] ?? '#888'}; --fall: ${ROWS - row};`
						: ''}
					disabled={disabled || !oncolumn || colFull[col]}
					aria-label={piece
						? `${columnLabel(col)}${row + 1} — ${sideNames[piece.side - 1] ?? `side ${piece.side}`}${piece.item_name ? `, ${piece.item_name}` : ''}`
						: `${columnLabel(col)}${row + 1} — empty`}
					onclick={() => oncolumn?.(col)}
				>
					{#if piece}<span class="disc"></span>{/if}
				</button>
			{/each}
		{/each}
	</div>
</div>

<style>
	.wrap {
		--gap: 3px;
		/* Floor on cell size. 0 on desktop (holes just fill the column); on a phone 25
		   columns would otherwise give ~14px holes, far under what a thumb can hit.
		   Below the floor the board scrolls inside its own box rather than shrinking,
		   so the PAGE never scrolls sideways. */
		--min-cell: 0px;
		display: grid;
		gap: 0.3rem;
		width: 100%;
		/* Both needed: without min-width:0 a grid/flex ancestor sizes to the board's
		   min-width instead of letting it scroll here, and the page goes sideways. */
		min-width: 0;
		overflow-x: auto;
		overscroll-behavior-x: contain;
	}

	.collabels {
		display: grid;
		grid-template-columns: repeat(var(--n), minmax(0, 1fr));
		gap: var(--gap);
		min-width: calc(var(--n) * (var(--min-cell) + var(--gap)));
		font-size: clamp(0.45rem, calc(22rem / var(--n) / 3), 0.7rem);
		color: var(--muted);
		text-shadow: var(--ts);
	}
	.collabels span {
		display: flex;
		align-items: center;
		justify-content: center;
		min-width: 0;
		overflow: hidden;
	}
	.collabels span.full {
		opacity: 0.4;
	}

	/* THE FRAME. One slab of blue plastic with the holes punched out of it — a background
	   per cell would read as 250 tiles rather than one board. */
	.board {
		display: grid;
		grid-template-columns: repeat(var(--n), minmax(0, 1fr));
		grid-template-rows: repeat(var(--rows), minmax(0, 1fr));
		gap: var(--gap);
		/* Square holes at ANY width — this is what keeps the board inside its column. */
		aspect-ratio: calc(var(--n) / var(--rows));
		min-width: calc(var(--n) * (var(--min-cell) + var(--gap)));
		padding: var(--gap);
		background-image:
			linear-gradient(180deg, rgba(255, 255, 255, 0.08) 0%, transparent 22%),
			linear-gradient(180deg, #2f6ea8 0%, #24567f 55%, #1a3f5e 100%);
		box-shadow:
			inset 0 0 26px rgba(0, 0, 0, 0.5),
			0 2px 0 rgba(0, 0, 0, 0.4);
		border-radius: 4px;
	}

	.hole {
		border-image: none;
		min-height: 0;
		margin: 0;
		padding: 0;
		aspect-ratio: 1;
		border: none;
		border-radius: 50%;
		/* An empty hole is a window through the frame to the dark behind it. */
		background: radial-gradient(circle at 38% 32%, #0d1b26 0%, #0a141c 60%, #060d13 100%);
		box-shadow:
			inset 0 2px 4px rgba(0, 0, 0, 0.9),
			inset 0 -1px 2px rgba(255, 255, 255, 0.07);
		display: flex;
		align-items: center;
		justify-content: center;
		overflow: hidden;
		cursor: default;
	}
	.hole:not(:disabled) {
		cursor: pointer;
	}
	.hole:not(:disabled):hover {
		box-shadow:
			inset 0 2px 4px rgba(0, 0, 0, 0.9),
			0 0 0 2px var(--accent);
	}

	.disc {
		width: 100%;
		height: 100%;
		border-radius: 50%;
		background:
			radial-gradient(circle at 36% 30%, rgba(255, 255, 255, 0.5) 0%, transparent 42%),
			radial-gradient(circle at 50% 50%, var(--disc) 0%, color-mix(in srgb, var(--disc) 72%, #000) 100%);
		box-shadow:
			inset 0 -2px 4px rgba(0, 0, 0, 0.45),
			0 0 3px rgba(0, 0, 0, 0.5);
	}

	/* A cell that is part of a connect four (or longer) pulses in its own colour. The
	   glow is on the disc, not the hole, so the frame stays put. */
	.hole.in-run .disc {
		box-shadow:
			inset 0 -2px 4px rgba(0, 0, 0, 0.45),
			0 0 8px 2px var(--disc);
		outline: 2px solid #fff;
		outline-offset: -2px;
	}

	@media (prefers-reduced-motion: no-preference) {
		/* The piece falls from above the board into its slot, with a small bounce — the
		   whole point of a Connect Four board is watching the piece drop. `--fall` is how
		   many rows it has to travel, so a piece landing on the floor falls further than
		   one landing on a stack. */
		.hole.newest .disc {
			animation: c4-drop 0.55s cubic-bezier(0.45, 0.05, 0.55, 1) 1;
		}
		.hole.in-run .disc {
			animation: c4-glow 1.6s ease-in-out infinite;
		}
		@keyframes c4-drop {
			0% {
				transform: translateY(calc(-1 * var(--fall) * 118%));
				opacity: 0.85;
			}
			72% {
				transform: translateY(0);
			}
			84% {
				transform: translateY(-12%);
			}
			100% {
				transform: translateY(0);
			}
		}
		@keyframes c4-glow {
			0%,
			100% {
				box-shadow:
					inset 0 -2px 4px rgba(0, 0, 0, 0.45),
					0 0 6px 1px var(--disc);
			}
			50% {
				box-shadow:
					inset 0 -2px 4px rgba(0, 0, 0, 0.45),
					0 0 16px 5px var(--disc);
			}
		}
	}

	@media (max-width: 720px) {
		.wrap {
			/* A thumb needs far more than the ~14px 25 columns would give on a phone.
			   Past this the board scrolls inside itself; the page still does not. */
			--min-cell: 26px;
			--gap: 2px;
		}
	}
</style>
