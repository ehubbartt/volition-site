<script lang="ts">
	// One Battleship grid. Used for both boards on every page — your own water (ships
	// visible) and the enemy's (only craters), so hit/miss rendering can never drift
	// between the two. Purely presentational: it renders what it is given and reports
	// clicks, it never decides what is legal.
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
		disabled = false,
		onpick = undefined
	}: {
		size: number;
		fleet?: Ship[] | null;
		shots?: ShotLike[];
		mode?: 'view' | 'target';
		span?: number;
		sunkShipIds?: string[];
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

	function pick(x: number, y: number) {
		if (disabled || mode !== 'target' || !onpick) return;
		onpick(Math.min(x, maxAnchor), Math.min(y, maxAnchor));
	}

	const rows = $derived(Array.from({ length: size }, (_, i) => i));
</script>

<div class="wrap" style="--n: {size}">
	<div class="corner"></div>
	{#each rows as x (x)}
		<div class="colhead" style="grid-column: {x + 2}; grid-row: 1">{columnLabel(x)}</div>
	{/each}

	{#each rows as y (y)}
		<div class="rowhead" style="grid-column: 1; grid-row: {y + 2}">{y + 1}</div>
		{#each rows as x (x)}
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
				class:clickable={mode === 'target' && !disabled}
				style="grid-column: {x + 2}; grid-row: {y + 2}"
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
				{#if shot?.hit}<span class="mark">✳</span>
				{:else if shot}<span class="mark dot">•</span>{/if}
			</button>
		{/each}
	{/each}
</div>

<style>
	.wrap {
		display: grid;
		grid-template-columns: 1.4rem repeat(var(--n), minmax(0, 1fr));
		grid-template-rows: 1.1rem repeat(var(--n), auto);
		gap: 2px;
		max-width: 100%;
	}
	.colhead,
	.rowhead {
		display: flex;
		align-items: center;
		justify-content: center;
		font-size: 0.7rem;
		color: var(--muted);
		text-shadow: var(--ts);
	}
	.corner {
		grid-column: 1;
		grid-row: 1;
	}
	.cell {
		aspect-ratio: 1;
		min-width: 0;
		padding: 0;
		border: 1px solid var(--border);
		border-radius: 2px;
		background: var(--surface-alt);
		color: var(--text);
		font-size: 0.8rem;
		line-height: 1;
		display: flex;
		align-items: center;
		justify-content: center;
		/* Water. Kept subtle so ships and craters carry the contrast. */
		box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.02);
	}
	.cell.clickable {
		cursor: crosshair;
	}
	.cell.ship {
		/* A hull has to read at a glance against water in every theme, so mix toward the
		   theme's own text colour rather than hardcoding a grey. */
		background: color-mix(in srgb, var(--text) 34%, var(--surface-alt));
		border-color: color-mix(in srgb, var(--text) 55%, transparent);
		box-shadow: inset 0 0 0 1px rgba(0, 0, 0, 0.35);
	}
	.cell.miss {
		background: var(--surface-alt);
		color: var(--muted);
	}
	.cell.hit {
		background: var(--danger-bg);
		border-color: var(--danger);
		color: var(--danger);
	}
	.cell.sunk {
		background: #1a0f0d;
		border-color: #7a1010;
	}
	.cell.preview {
		outline: 2px solid var(--accent);
		outline-offset: -2px;
		background: var(--accent-soft);
	}
	.mark {
		font-weight: bold;
		text-shadow: var(--ts);
	}
	.dot {
		font-size: 1.1rem;
	}
	@media (max-width: 720px) {
		.wrap {
			grid-template-columns: 1rem repeat(var(--n), minmax(0, 1fr));
			gap: 1px;
		}
		.colhead,
		.rowhead {
			font-size: 0.55rem;
		}
	}
</style>
