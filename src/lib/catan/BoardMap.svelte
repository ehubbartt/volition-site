<script lang="ts">
	import {
		boardHexes,
		hexCenter,
		hexId,
		hexPolygonPoints,
		vertexPos,
		edgeEndpoints,
		boardVertices,
		boardEdges,
		type VertexId,
		type EdgeId
	} from './geometry';
	import { TILE_TYPE_LABEL, type Board } from './board';

	interface Piece {
		teamId: string;
		kind: 'road' | 'settlement' | 'city';
		loc: string;
	}

	let {
		board,
		pieces = [],
		teamColors = {},
		highlightVertices = [],
		highlightEdges = [],
		frozenVertices = [],
		selectedVertex = null,
		onVertex,
		onEdge
	}: {
		board: Board;
		pieces?: Piece[];
		teamColors?: Record<string, string>;
		highlightVertices?: VertexId[];
		highlightEdges?: EdgeId[];
		frozenVertices?: VertexId[];
		selectedVertex?: VertexId | null;
		onVertex?: (v: VertexId) => void;
		onEdge?: (e: EdgeId) => void;
	} = $props();

	const SIZE = 46;
	const hexes = $derived(boardHexes(board.radius));
	const vertices = $derived(boardVertices(hexes));
	const edges = $derived(boardEdges(hexes));
	const pad = SIZE * 2.2;
	const extent = $derived(SIZE * Math.sqrt(3) * (board.radius + 0.5) + pad);
	const extentY = $derived(SIZE * (1.5 * board.radius + 1) + pad);

	const roads = $derived(pieces.filter((p) => p.kind === 'road'));
	const buildings = $derived(pieces.filter((p) => p.kind !== 'road'));
	const hlV = $derived(new Set(highlightVertices));
	const hlE = $derived(new Set(highlightEdges));
	const frozen = $derived(new Set(frozenVertices));

	const TYPE_FILL: Record<string, string> = {
		boss: '#5b2a2a',
		skilling: '#2d4a2d',
		raids: '#43305e',
		custom: '#5a4a26'
	};
	const TYPE_ICON: Record<string, string> = {
		boss: '⚔', // ⚔
		skilling: '⛏', // ⛏
		raids: '♛', // ♛
		custom: '★' // ★
	};

	function edgeMid(e: EdgeId) {
		const [a, b] = edgeEndpoints(e);
		const pa = vertexPos(a, SIZE);
		const pb = vertexPos(b, SIZE);
		return { x: (pa.x + pb.x) / 2, y: (pa.y + pb.y) / 2 };
	}

	/** Point just outside the coast, for port badges: push the edge midpoint away from origin. */
	function portPos(e: EdgeId) {
		const m = edgeMid(e);
		const len = Math.hypot(m.x, m.y) || 1;
		const k = (len + SIZE * 0.95) / len;
		return { x: m.x * k, y: m.y * k };
	}

	function portLabel(kind: string, rate: number) {
		if (kind === 'generic') return `${rate}:1`;
		return `${rate}:1 ${TILE_TYPE_LABEL[kind as keyof typeof TILE_TYPE_LABEL][0]}`;
	}
</script>

<svg
	viewBox="{-extent} {-extentY} {extent * 2} {extentY * 2}"
	class="board"
	role="img"
	aria-label="Gielinor Catan board"
>
	<!-- tiles -->
	{#each hexes as h (hexId(h.q, h.r))}
		{@const tile = board.tiles[hexId(h.q, h.r)]}
		{@const c = hexCenter(h, SIZE)}
		{#if tile}
			<g>
				<polygon
					points={hexPolygonPoints(h, SIZE)}
					fill={TYPE_FILL[tile.type]}
					stroke="var(--catan-hex-stroke, #1a1611)"
					stroke-width="3"
				/>
				<text class="tile-icon" x={c.x} y={c.y - SIZE * 0.32}>{TYPE_ICON[tile.type]}</text>
				<circle cx={c.x} cy={c.y + SIZE * 0.22} r={SIZE * 0.26} class="rating-chip" class:prime={tile.rating <= 2} />
				<text class="rating" x={c.x} y={c.y + SIZE * 0.22} class:prime={tile.rating <= 2}>{tile.rating}</text>
				<text class="tile-type" x={c.x} y={c.y + SIZE * 0.72}>{TILE_TYPE_LABEL[tile.type]}</text>
			</g>
		{/if}
	{/each}

	<!-- ports -->
	{#each board.ports as port (port.edge)}
		{@const p = portPos(port.edge)}
		{@const m = edgeMid(port.edge)}
		<line x1={m.x} y1={m.y} x2={p.x} y2={p.y} class="port-tie" />
		<circle cx={p.x} cy={p.y} r={SIZE * 0.42} class="port {port.kind}" />
		<text class="port-label" x={p.x} y={p.y}>{portLabel(port.kind, port.rate)}</text>
	{/each}

	<!-- roads -->
	{#each roads as r (r.loc)}
		{@const [a, b] = edgeEndpoints(r.loc)}
		{@const pa = vertexPos(a, SIZE)}
		{@const pb = vertexPos(b, SIZE)}
		<line
			x1={pa.x + (pb.x - pa.x) * 0.15}
			y1={pa.y + (pb.y - pa.y) * 0.15}
			x2={pb.x - (pb.x - pa.x) * 0.15}
			y2={pb.y - (pb.y - pa.y) * 0.15}
			class="road"
			stroke={teamColors[r.teamId] ?? '#ccc'}
		/>
	{/each}

	<!-- clickable edges (legal spots highlighted) -->
	{#if onEdge}
		{#each edges as e (e)}
			{@const [a, b] = edgeEndpoints(e)}
			{@const pa = vertexPos(a, SIZE)}
			{@const pb = vertexPos(b, SIZE)}
			{#if hlE.has(e)}
				<line x1={pa.x} y1={pa.y} x2={pb.x} y2={pb.y} class="edge-hl" onclick={() => onEdge?.(e)} role="button" tabindex="0" aria-label="Build road" onkeydown={(ev) => ev.key === 'Enter' && onEdge?.(e)} />
			{/if}
		{/each}
	{/if}

	<!-- buildings -->
	{#each buildings as bp (bp.loc)}
		{@const p = vertexPos(bp.loc, SIZE)}
		{#if bp.kind === 'city'}
			<rect x={p.x - 11} y={p.y - 11} width="22" height="22" rx="3" class="building" fill={teamColors[bp.teamId] ?? '#ccc'} />
			<text class="city-star" x={p.x} y={p.y}>{'✦'}</text>
		{:else}
			<circle cx={p.x} cy={p.y} r="9" class="building" fill={teamColors[bp.teamId] ?? '#ccc'} />
		{/if}
		{#if frozen.has(bp.loc)}
			<circle cx={p.x} cy={p.y} r="14" class="freeze-ring" />
		{/if}
	{/each}

	<!-- clickable vertices -->
	{#if onVertex}
		{#each vertices as v (v)}
			{@const p = vertexPos(v, SIZE)}
			{#if hlV.has(v) || buildings.some((b) => b.loc === v)}
				<circle
					cx={p.x}
					cy={p.y}
					r="12"
					class="vertex-target"
					class:hl={hlV.has(v)}
					class:selected={selectedVertex === v}
					onclick={() => onVertex?.(v)}
					role="button"
					tabindex="0"
					aria-label="Corner {v}"
					onkeydown={(ev) => ev.key === 'Enter' && onVertex?.(v)}
				/>
			{/if}
		{/each}
	{/if}
</svg>

<style>
	.board {
		width: 100%;
		height: auto;
		display: block;
		user-select: none;
	}
	.tile-icon {
		font-size: 20px;
		text-anchor: middle;
		dominant-baseline: central;
		fill: #e8e0d0;
		opacity: 0.9;
	}
	.rating-chip {
		fill: #e8dcc0;
		stroke: #1a1611;
		stroke-width: 1.5;
	}
	.rating-chip.prime {
		fill: #ffd25e;
	}
	.rating {
		font-size: 17px;
		font-weight: 700;
		text-anchor: middle;
		dominant-baseline: central;
		fill: #241d12;
	}
	.tile-type {
		font-size: 10px;
		text-anchor: middle;
		dominant-baseline: central;
		fill: #cfc4ab;
		opacity: 0.85;
		letter-spacing: 0.04em;
	}
	.port-tie {
		stroke: #7a6a4a;
		stroke-width: 2;
		stroke-dasharray: 3 3;
	}
	.port {
		fill: #241d12;
		stroke: #b89e6a;
		stroke-width: 2;
	}
	.port.raids {
		stroke: #a97fe8;
	}
	.port-label {
		font-size: 11px;
		font-weight: 700;
		text-anchor: middle;
		dominant-baseline: central;
		fill: #e8dcc0;
	}
	.road {
		stroke-width: 7;
		stroke-linecap: round;
	}
	.edge-hl {
		stroke: #ffd25e;
		stroke-width: 10;
		stroke-linecap: round;
		opacity: 0.35;
		cursor: pointer;
	}
	.edge-hl:hover {
		opacity: 0.8;
	}
	.building {
		stroke: #14100a;
		stroke-width: 2;
	}
	.city-star {
		font-size: 13px;
		text-anchor: middle;
		dominant-baseline: central;
		fill: #14100a;
		pointer-events: none;
	}
	.freeze-ring {
		fill: none;
		stroke: #6fc3ff;
		stroke-width: 3;
		stroke-dasharray: 4 3;
	}
	.vertex-target {
		fill: transparent;
		cursor: pointer;
	}
	.vertex-target.hl {
		fill: #ffd25e;
		opacity: 0.45;
	}
	.vertex-target.hl:hover {
		opacity: 0.9;
	}
	.vertex-target.selected {
		stroke: #ffd25e;
		stroke-width: 3;
		opacity: 1;
	}
</style>
