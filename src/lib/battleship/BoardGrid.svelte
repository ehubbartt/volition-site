<script lang="ts">
	// One Battleship grid. Used for both boards on every page — your own water (ships
	// visible) and the enemy's (only craters), so hit/miss rendering can never drift
	// between the two. Purely presentational: it renders what it is given and reports
	// clicks, it never decides what is legal.
	//
	// Layout note: the labels and the play area are SEPARATE grids sharing one gap, so
	// the water is exactly the n×n play area (nothing bleeds under the labels) and the
	// cells can be driven off `aspect-ratio` to stay square at any board size.
	import { anchorFor, cellId, columnLabel, type CellId, type Ship } from './rules';

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
		/** The COMMITTED square — drawn persistently, unlike the transient hover preview. */
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

	// WHICH ship a cell belongs to. `sunkShipIds` is documented as working even when the
	// fleet is withheld, and it did not: sunk-ness was resolved through `shipByCell`,
	// which is empty on an enemy board, so every wreck rendered as ordinary damage — on
	// the one board where knowing what is already dead actually changes your next shot.
	// A hit shot carries the ship it struck, so fall back to that.
	const shipIdByCell = $derived.by(() => {
		const m = new Map<string, string>();
		for (const s of fleet ?? []) for (const c of s.cells) m.set(c, s.id);
		for (const s of shots) if (s.hit && s.shipId) m.set(s.cell, s.shipId);
		return m;
	});

	/** Does the neighbour in this direction belong to the same hull? */
	const sameShip = (x: number, y: number, dx: number, dy: number, shipId: string | null) => {
		if (!shipId) return false;
		const nx = x + dx;
		const ny = y + dy;
		if (nx < 0 || ny < 0 || nx >= size || ny >= size) return false;
		return shipIdByCell.get(cellId(nx, ny)) === shipId;
	};

	// The footprint for a square you are POINTING AT. `anchorFor` centres it on that square
	// (a 3x3 wraps around it) and clamps it so the whole bomb lands on the board, matching
	// the server's "the whole bomb has to land" rule. Both previews go through it, so the
	// hover, the committed highlight and the shot fired can never disagree.
	let hover = $state<{ x: number; y: number } | null>(null);
	const footprint = (cell: { x: number; y: number } | null) => {
		const out = new Set<string>();
		if (!cell) return out;
		const a = anchorFor(cell, span, size);
		for (let dy = 0; dy < span; dy++) for (let dx = 0; dx < span; dx++) out.add(cellId(a.x + dx, a.y + dy));
		return out;
	};
	const previewCells = $derived(mode === 'target' ? footprint(hover) : new Set<string>());

	// The squares the CHOSEN shot will cover. Separate from the hover preview on purpose:
	// hover is exploratory and vanishes the moment the pointer leaves, but a player who has
	// picked a square then moves to the Fire button — and losing the highlight at exactly
	// that moment means firing off a line of text alone.
	const targetCells = $derived(footprint(target));

	// Reports the square that was CLICKED, not an anchor. Clamping the click would drag
	// the aim sideways near an edge; `anchorFor` handles fitting the footprint instead, so
	// what you point at is what the highlight wraps around.
	function pick(x: number, y: number) {
		if (disabled || mode !== 'target' || !onpick) return;
		onpick(x, y);
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
				{@const shipId = shipIdByCell.get(id) ?? null}
				{@const sunk = !!shipId && sunkSet.has(shipId)}
				<button
					type="button"
					class="cell"
					class:ship={!!ship && !shot}
					class:hit={shot?.hit}
					class:miss={shot && !shot.hit}
					class:sunk
					class:et={sunk && !sameShip(x, y, 0, -1, shipId)}
					class:er={sunk && !sameShip(x, y, 1, 0, shipId)}
					class:eb={sunk && !sameShip(x, y, 0, 1, shipId)}
					class:el={sunk && !sameShip(x, y, -1, 0, shipId)}
					class:preview={previewCells.has(id)}
					class:target={targetCells.has(id)}
					disabled={mode !== 'target' || disabled}
					aria-label="{columnLabel(x)}{y + 1}{shot
						? sunk
							? ' — sunk'
							: shot.hit
								? ' — hit, still afloat'
								: ' — miss'
						: ''}{ship && !shot ? ' — your ship' : ''}"
					onmouseenter={() => (hover = { x, y })}
					onfocus={() => (hover = { x, y })}
					onmouseleave={() => (hover = null)}
					onblur={() => (hover = null)}
					onclick={() => pick(x, y)}
				>
					{#if shot?.hit}<span class="mark">{sunk ? '✖' : '✳'}</span>{/if}
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
		   25x25 board would otherwise give ~10px cells, far under the ~44px a thumb
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

	/* A hit on a hull that is STILL AFLOAT: burning. Bright, and worth another shot
	   next to it. */
	.cell.hit {
		background: radial-gradient(circle at 50% 45%, #ff6a3d 0%, #a11b0b 60%, #5c0f06 100%);
		color: #ffe6b0;
		box-shadow: inset 0 0 6px rgba(0, 0, 0, 0.6);
	}
	/* A cell of a hull that is FULLY DOWN: burnt out. Dark, and dead water — there is
	   nothing left there to shoot. */
	.cell.sunk {
		position: relative;
		background: radial-gradient(circle at 50% 45%, #3a2a26 0%, #1b1310 70%, #0d0908 100%);
		color: rgba(255, 220, 190, 0.55);
	}

	/* Colour alone would leave "burning" and "burnt out" as two shades of dark red, told
	   apart only by whichever cell happens to sit next to which. The outline is the real
	   signal: it traces the OUTSIDE edge of a sunk hull, so a wreck reads as one object of
	   a known length and orientation instead of n unrelated craters. Drawn per edge — an
	   edge is outside when the neighbour is not the same ship. */
	.cell.sunk::after {
		content: '';
		position: absolute;
		inset: 0;
		pointer-events: none;
		border-style: solid;
		border-color: rgba(255, 208, 150, 0.75);
		/* Each edge class sets its own custom property, so unlike four competing
		   box-shadow rules these combine instead of overwriting each other. */
		border-width: var(--bt, 0) var(--br, 0) var(--bb, 0) var(--bl, 0);
	}
	.cell.et { --bt: 2px; }
	.cell.er { --br: 2px; }
	.cell.eb { --bb: 2px; }
	.cell.el { --bl: 2px; }

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
