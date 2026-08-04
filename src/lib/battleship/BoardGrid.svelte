<script lang="ts">
	// One Battleship grid. Used for both boards on every page — your own water (ships
	// visible) and the enemy's (only craters), so hit/miss rendering can never drift
	// between the two. Purely presentational: it renders what it is given and reports
	// clicks, it never decides what is legal.
	//
	// Layout note: the labels and the play area are SEPARATE grids sharing one gap, so
	// the water is exactly the n×n play area (nothing bleeds under the labels) and the
	// cells can be driven off `aspect-ratio` to stay square at any board size.
	import { cellId, columnLabel, type CellId, type Ship } from './rules';

	interface ShotLike {
		cell: CellId;
		hit: boolean;
		shipId?: string | null;
	}

	let {
		size,
		/** Ships to draw. null = withheld (an enemy board a player may not see). */
		fleet = null,
		shots = [],
		/** 'view' = read-only, 'target' = clickable with a footprint preview. */
		mode = 'view',
		/** Footprint edge for the targeting preview (1, 2 or 3). */
		span = 1,
		/** Ship ids fully sunk — drawn even when the fleet itself is withheld. */
		sunkShipIds = [],
		/** The COMMITTED anchor — drawn persistently, unlike the transient hover preview. */
		target = null,
		disabled = false,
		onpick = undefined
	}: {
		size: number;
		fleet?: Ship[] | null;
		shots?: ShotLike[];
		mode?: 'view' | 'target';
		span?: number;
		sunkShipIds?: string[];
		target?: { x: number; y: number } | null;
		disabled?: boolean;
		onpick?: (x: number, y: number) => void;
	} = $props();

	const shotByCell = $derived(new Map(shots.map((s) => [s.cell, s])));
	const shipByCell = $derived(
		new Map((fleet ?? []).flatMap((s) => s.cells.map((c) => [c, s] as const)))
	);
	const sunkSet = $derived(new Set(sunkShipIds));

	// Where the preview footprint sits. Clamped so it always fits, matching the server's
	// "the whole bomb has to land on the board" rule.
	let hover = $state<{ x: number; y: number } | null>(null);
	const maxAnchor = $derived(Math.max(0, size - span));
	const previewCells = $derived.by(() => {
		if (mode !== 'target' || !hover) return new Set<string>();
		const ax = Math.min(hover.x, maxAnchor);
		const ay = Math.min(hover.y, maxAnchor);
		const out = new Set<string>();
		for (let dy = 0; dy < span; dy++) for (let dx = 0; dx < span; dx++) out.add(cellId(ax + dx, ay + dy));
		return out;
	});

	// The squares the CHOSEN shot will cover. Separate from the hover preview on purpose:
	// hover is exploratory and vanishes the moment the pointer leaves, but a player who has
	// picked a square then moves to the Fire button — and losing the highlight at exactly
	// that moment means firing off a line of text alone.
	const targetCells = $derived.by(() => {
		if (!target) return new Set<string>();
		const ax = Math.min(target.x, maxAnchor);
		const ay = Math.min(target.y, maxAnchor);
		const out = new Set<string>();
		for (let dy = 0; dy < span; dy++) for (let dx = 0; dx < span; dx++) out.add(cellId(ax + dx, ay + dy));
		return out;
	});

	function pick(x: number, y: number) {
		if (disabled || mode !== 'target' || !onpick) return;
		onpick(Math.min(x, maxAnchor), Math.min(y, maxAnchor));
	}

	const axis = $derived(Array.from({ length: size }, (_, i) => i));
</script>

<div class="wrap" style="--n: {size}">
	<div class="corner"></div>
	<div class="colheads">
		{#each axis as x (x)}<span>{columnLabel(x)}</span>{/each}
	</div>
	<div class="rowheads">
		{#each axis as y (y)}<span>{y + 1}</span>{/each}
	</div>

	<div class="water" class:aiming={mode === 'target' && !disabled}>
		{#each axis as y (y)}
			{#each axis as x (x)}
				{@const id = cellId(x, y)}
				{@const shot = shotByCell.get(id)}
				{@const ship = shipByCell.get(id)}
				{@const sunk = ship ? sunkSet.has(ship.id) : false}
				<button
					type="button"
					class="cell"
					class:ship={!!ship && !shot}
					class:hit={shot?.hit}
					class:miss={shot && !shot.hit}
					class:sunk
					class:preview={previewCells.has(id)}
					class:target={targetCells.has(id)}
					disabled={mode !== 'target' || disabled}
					aria-label="{columnLabel(x)}{y + 1}{shot ? (shot.hit ? ' — hit' : ' — miss') : ''}{ship &&
					!shot
						? ' — your ship'
						: ''}"
					onmouseenter={() => (hover = { x, y })}
					onfocus={() => (hover = { x, y })}
					onmouseleave={() => (hover = null)}
					onblur={() => (hover = null)}
					onclick={() => pick(x, y)}
				>
					{#if shot?.hit}<span class="mark">✳</span>{/if}
				</button>
			{/each}
		{/each}
	</div>
</div>

<style>
	.wrap {
		--gap: 1px;
		--label: 1.3rem;
		/* Floor on cell size. 0 on desktop (cells just fill the column); on a phone a
		   19x19 board would otherwise give ~12px cells, far under the ~44px a thumb
		   needs — and a mis-tap here FIRES A BOMB at the wrong square, which can't be
		   undone. Below the floor the board scrolls inside itself instead of shrinking. */
		--min-cell: 0px;
		display: grid;
		grid-template-columns: var(--label) minmax(0, 1fr);
		grid-template-rows: 1rem minmax(0, 1fr);
		gap: 0.15rem;
		width: 100%;
		overflow-x: auto;
		overscroll-behavior-x: contain;
	}
	.corner {
		grid-column: 1;
		grid-row: 1;
	}
	.colheads,
	.rowheads {
		display: grid;
		gap: var(--gap);
		font-size: clamp(0.45rem, calc(22rem / var(--n) / 3), 0.7rem);
		color: var(--muted);
		text-shadow: var(--ts);
	}
	.colheads {
		grid-column: 2;
		grid-row: 1;
		grid-template-columns: repeat(var(--n), minmax(0, 1fr));
		min-width: calc(var(--n) * (var(--min-cell) + var(--gap)));
	}
	.rowheads {
		grid-column: 1;
		grid-row: 2;
		grid-template-rows: repeat(var(--n), minmax(0, 1fr));
		/* Pinned while the board scrolls under it — the row number is half of how you
		   tell someone where you hit. */
		position: sticky;
		left: 0;
		z-index: 2;
		background: var(--surface-alt);
	}
	.colheads span,
	.rowheads span {
		display: flex;
		align-items: center;
		justify-content: center;
		min-width: 0;
		overflow: hidden;
	}

	/* THE SEA. One continuous body of water under the whole play area — a gradient per
	   cell would read as 361 tiles, not an ocean. Depth gradient + two offset swell
	   bands + a fine ripple, all static (no animation: this sits behind a grid someone
	   is reading, and it must not fight for attention or annoy reduced-motion users). */
	.water {
		grid-column: 2;
		grid-row: 2;
		display: grid;
		grid-template-columns: repeat(var(--n), minmax(0, 1fr));
		grid-template-rows: repeat(var(--n), minmax(0, 1fr));
		gap: var(--gap);
		/* Square play area at ANY board size — this is what keeps the cells square and
		   the whole board inside its column. */
		aspect-ratio: 1;
		min-width: calc(var(--n) * (var(--min-cell) + var(--gap)));
		padding: var(--gap);
		background-color: #0b2733;
		background-image:
			repeating-linear-gradient(
				100deg,
				rgba(255, 255, 255, 0.045) 0 2px,
				transparent 2px 9px
			),
			repeating-linear-gradient(
				78deg,
				rgba(120, 200, 220, 0.05) 0 3px,
				transparent 3px 17px
			),
			radial-gradient(120% 90% at 30% 0%, #17495c 0%, #0d2f3d 45%, #071d27 100%);
		box-shadow: inset 0 0 22px rgba(0, 0, 0, 0.55);
		border-radius: 2px;
	}
	.water.aiming .cell:not(:disabled) {
		cursor: crosshair;
	}

	.cell {
		/* The global OSRS <button> style sets min-height 38px and a bronze border-image;
		   both have to go or the cells stop being square and the sea disappears. */
		min-height: 0;
		min-width: 0;
		padding: 0;
		margin: 0;
		border: none;
		border-image: none;
		border-radius: 0;
		background: rgba(255, 255, 255, 0.028);
		box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.05);
		color: var(--text);
		display: flex;
		align-items: center;
		justify-content: center;
		font-size: clamp(0.4rem, calc(26rem / var(--n) / 2), 0.85rem);
		line-height: 1;
	}
	.cell:hover:not(:disabled) {
		background: rgba(255, 255, 255, 0.1);
	}

	/* A hull: metal grey, deliberately opaque so it reads as sitting ON the water. */
	.cell.ship {
		background: linear-gradient(180deg, #8d8f92, #5f6367);
		box-shadow:
			inset 0 1px 0 rgba(255, 255, 255, 0.35),
			inset 0 -1px 0 rgba(0, 0, 0, 0.45);
	}

	/* A miss is a splash ring on open water, not a grey dot. */
	.cell.miss {
		background:
			radial-gradient(circle at 50% 50%, rgba(255, 255, 255, 0.5) 0 12%, transparent 14%),
			radial-gradient(circle at 50% 50%, transparent 26%, rgba(255, 255, 255, 0.28) 28% 34%, transparent 36%),
			rgba(255, 255, 255, 0.03);
	}

	.cell.hit {
		background: radial-gradient(circle at 50% 45%, #ff6a3d 0%, #a11b0b 60%, #5c0f06 100%);
		color: #ffe6b0;
		box-shadow: inset 0 0 6px rgba(0, 0, 0, 0.6);
	}
	.cell.sunk {
		background: radial-gradient(circle at 50% 45%, #4a1109 0%, #24070a 70%, #12040a 100%);
		color: rgba(255, 200, 160, 0.65);
	}

	/* Exploring: a soft wash that follows the pointer. */
	.cell.preview {
		outline: 2px solid rgba(255, 152, 31, 0.7);
		outline-offset: -2px;
		background: rgba(255, 152, 31, 0.22);
	}
	/* Chosen: stays put until you fire or pick elsewhere, and reads as committed. */
	.cell.target {
		outline: 2px solid var(--yellow);
		outline-offset: -2px;
		background: rgba(255, 152, 31, 0.45);
		box-shadow: inset 0 0 0 1px rgba(0, 0, 0, 0.5);
		z-index: 1;
	}

	.mark {
		font-weight: bold;
		text-shadow: 0 1px 2px rgba(0, 0, 0, 0.9);
	}

	@media (max-width: 720px) {
		.wrap {
			--label: 1.1rem;
			/* Big enough to hit reliably; the board scrolls sideways within its own box
			   rather than making the PAGE scroll. */
			--min-cell: 26px;
		}
	}
</style>
