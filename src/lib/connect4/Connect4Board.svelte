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
	//
	// The board renders only the first `revealed` pieces in claim order, which is what lets
	// the page play a run of claims into place (see playback.svelte.ts) rather than swapping
	// the whole board at once.
	import TileRail from './TileRail.svelte';
	import TileHoverCard, { type CardInfo } from './TileHoverCard.svelte';
	import { COLS, ROWS, cellId, columnLabel, type LiveTile, type Piece } from './rules';

	let {
		pieces = [],
		live = [],
		cols = COLS,
		rows = ROWS,
		claiming,
		sideColors = ['#ef4444', '#eab308'],
		sideNames = ['Red', 'Yellow'],
		runCells = new Set<string>(),
		revealed = null,
		falling = null,
		selected = null,
		onselect,
		oncolumn,
		disabled = false
	}: {
		pieces: Piece[];
		live: (LiveTile | null)[];
		/** Board dimensions — per game since sizes became configurable. */
		cols?: number;
		rows?: number;
		/** Columns whose objective is claimed but not yet replaced — see TileRail. */
		claiming?: Set<number>;
		sideColors?: string[];
		sideNames?: string[];
		/** Cells belonging to a scoring run — they glow. */
		runCells?: Set<string>;
		/** Show only the first N pieces in claim order. null = the whole board. */
		revealed?: number | null;
		/** The piece id currently dropping — it gets the fall animation. */
		falling?: string | null;
		selected?: number | null;
		onselect?: (col: number) => void;
		/** Clicking a column (admin manual credit). Omit for a read-only board. */
		oncolumn?: (col: number) => void;
		disabled?: boolean;
	} = $props();

	// Claim order is the order pieces arrive from the server (ordered by claimed_at).
	const shown = $derived(revealed === null ? pieces : pieces.slice(0, Math.max(0, revealed)));
	const byCell = $derived(new Map(shown.map((p) => [cellId(p.col, p.row), p])));

	// Top-down render order, so grid row 1 is the top of the board and row 0 is the floor.
	const rowsTopDown = $derived(Array.from({ length: rows }, (_, i) => rows - 1 - i));
	const colList = $derived(Array.from({ length: cols }, (_, i) => i));
	const colFull = $derived(colList.map((c) => shown.filter((p) => p.col === c).length >= rows));

	// Hover card, for BOTH the objectives on the rail and the pieces on the board.
	// Anchored from the element's own rect so it reads next to the thing you pointed at
	// rather than in a panel somewhere below a 250-cell board.
	//
	// It carries wiki links, so it must survive the pointer leaving the tile on its way to
	// the card: hiding is deferred a beat, and the card cancels that when entered.
	let hovered = $state<CardInfo | null>(null);
	let hideTimer: ReturnType<typeof setTimeout> | null = null;
	// Whether the pointer is on the card itself. This has to be a FLAG checked when the
	// timer fires, not a cancel: pointer events are dispatched before their compatibility
	// mouse events, so the card's pointerenter arrives BEFORE the tile's mouseleave — a
	// cancel would be undone by the schedule that follows it, and the card always hid just
	// as you reached the links.
	let overCard = false;
	function show(info: CardInfo) {
		if (hideTimer) clearTimeout(hideTimer);
		hovered = info;
	}
	function leave() {
		if (hideTimer) clearTimeout(hideTimer);
		hideTimer = setTimeout(() => {
			if (!overCard) hovered = null;
		}, 260);
	}
	const keep = () => {
		overCard = true;
		if (hideTimer) clearTimeout(hideTimer);
	};
	const release = () => {
		overCard = false;
		leave();
	};

	const claimedVia = (p: Piece) =>
		p.drop_key?.startsWith('manual:') ? 'credited by hand' : p.drop_key?.startsWith('test-') ? 'simulated' : 'from a Dink drop';

	function enter(e: MouseEvent | FocusEvent, piece: Piece | undefined) {
		if (!piece) return;
		const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
		show({
			kind: 'piece',
			itemName: piece.item_name ?? 'Unknown drop',
			source: piece.source,
			where: `${columnLabel(piece.col)}${piece.row + 1}`,
			sideName: sideNames[piece.side - 1] ?? `side ${piece.side}`,
			sideColor: sideColors[piece.side - 1],
			byRsn: piece.by_rsn,
			via: claimedVia(piece),
			x: r.left + r.width / 2,
			y: r.top
		});
	}

	function railHover(info: { slot: LiveTile; x: number; y: number } | null) {
		if (!info) return leave();
		show({
			kind: 'tile',
			itemName: info.slot.tile.item_name,
			source: info.slot.tile.source,
			ehb: info.slot.tile.ehb,
			where: `column ${columnLabel(info.slot.col)}`,
			x: info.x,
			y: info.y
		});
	}
</script>

<svelte:window onscroll={leave} />

<div class="wrap" style="--n: {cols}; --rows: {rows};">
	<TileRail {live} {claiming} {selected} {onselect} onhover={railHover} />

	<div class="collabels" aria-hidden="true">
		{#each colList as c (c)}<span class:full={colFull[c]}>{columnLabel(c)}</span>{/each}
	</div>

	<div class="board" role="grid" aria-label="Connect Four board, {cols} columns by {rows} rows">
		{#each rowsTopDown as row (row)}
			{#each colList as col (col)}
				{@const id = cellId(col, row)}
				{@const piece = byCell.get(id)}
				<button
					type="button"
					class="hole"
					class:filled={!!piece}
					class:in-run={runCells.has(id)}
					class:newest={!!piece && falling === piece.id}
					style={piece ? `--disc: ${sideColors[piece.side - 1] ?? '#888'}; --fall: ${rows - row};` : ''}
					disabled={disabled || !oncolumn || colFull[col]}
					aria-label={piece
						? `${columnLabel(col)}${row + 1} — ${sideNames[piece.side - 1] ?? `side ${piece.side}`}${piece.item_name ? `, ${piece.item_name}` : ''}`
						: `${columnLabel(col)}${row + 1} — empty`}
					onmouseenter={(e) => enter(e, piece)}
					onfocus={(e) => enter(e, piece)}
					onmouseleave={leave}
					onblur={leave}
					onclick={() => oncolumn?.(col)}
				>
					{#if piece}<span class="disc"></span>{/if}
				</button>
			{/each}
		{/each}
	</div>
</div>

{#if hovered}
	<TileHoverCard info={hovered} onkeep={keep} onrelease={release} />
{/if}

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
	.hole.filled {
		cursor: help;
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
