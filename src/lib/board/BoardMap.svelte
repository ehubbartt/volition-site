<script lang="ts">
	import type { BoardNode, BoardTopology } from './topology';

	interface NodeContent {
		name: string;
		faq_html: string | null;
	}

	let {
		topology,
		lockedFloors = [2, 3],
		content = {},
		doneByTile = {},
		onNodeClick
	}: {
		topology: BoardTopology;
		lockedFloors?: number[];
		content?: Record<string, NodeContent>;
		doneByTile?: Record<string, boolean>;
		onNodeClick?: (id: string) => void;
	} = $props();

	const MIN_ZOOM = 0.5;
	const MAX_ZOOM = 5;
	const PAD = 40;
	const DRAG_THRESHOLD = 5;

	const lockedSet = $derived(new Set(lockedFloors));

	let zoom = $state(1);
	let panX = $state(0);
	let panY = $state(0);
	let isPanning = $state(false);
	let currentFloor = $state(1);
	let dragStartX = 0;
	let dragStartY = 0;
	// Track real drags so a click that pans the canvas doesn't also open a tile.
	let pointerDownX = 0;
	let pointerDownY = 0;
	let dragMoved = false;

	function handleNodeClick(id: string) {
		if (dragMoved) return;
		if (!content[id]) return;
		onNodeClick?.(id);
	}

	function handleNodeKey(e: KeyboardEvent, id: string) {
		if (e.key !== 'Enter' && e.key !== ' ') return;
		e.preventDefault();
		if (content[id]) onNodeClick?.(id);
	}

	const visible = $derived.by(() => {
		const band = topology.floors.find((f) => f.floor === currentFloor) ?? topology.floors[0];
		const nodes = topology.nodes.filter((n) => n.floor === currentFloor);
		const nodeIds = new Set(nodes.map((n) => n.id));
		const edges = topology.edges.filter((e) => nodeIds.has(e.from) && nodeIds.has(e.to));
		return { band, nodes, edges };
	});

	const nodeById = $derived(new Map(visible.nodes.map((n) => [n.id, n])));

	const vbStr = $derived.by(() => {
		const band = visible.band;
		const y = band.y - 12;
		const h = band.height + 24;
		return `${-PAD} ${y} ${topology.viewBox.w + PAD * 2} ${h}`;
	});

	function zoomIn() {
		zoom = Math.min(MAX_ZOOM, +(zoom + 0.25).toFixed(2));
	}

	function zoomOut() {
		zoom = Math.max(MIN_ZOOM, +(zoom - 0.25).toFixed(2));
	}

	function resetView() {
		zoom = 1;
		panX = 0;
		panY = 0;
	}

	function switchFloor(f: number) {
		if (f === currentFloor) return;
		currentFloor = f;
		resetView();
	}

	function onMouseDown(e: MouseEvent) {
		if (e.button !== 0) return;
		isPanning = true;
		dragMoved = false;
		pointerDownX = e.clientX;
		pointerDownY = e.clientY;
		dragStartX = e.clientX - panX;
		dragStartY = e.clientY - panY;
	}

	function onMouseMove(e: MouseEvent) {
		if (!isPanning) return;
		e.preventDefault();
		if (!dragMoved && Math.hypot(e.clientX - pointerDownX, e.clientY - pointerDownY) > DRAG_THRESHOLD) {
			dragMoved = true;
		}
		panX = e.clientX - dragStartX;
		panY = e.clientY - dragStartY;
	}

	function onMouseUp() {
		isPanning = false;
	}

	function onTouchStart(e: TouchEvent) {
		if (e.touches.length !== 1) return;
		isPanning = true;
		dragMoved = false;
		pointerDownX = e.touches[0].clientX;
		pointerDownY = e.touches[0].clientY;
		dragStartX = e.touches[0].clientX - panX;
		dragStartY = e.touches[0].clientY - panY;
	}

	function onTouchMove(e: TouchEvent) {
		if (!isPanning || e.touches.length !== 1) return;
		e.preventDefault();
		const t = e.touches[0];
		if (!dragMoved && Math.hypot(t.clientX - pointerDownX, t.clientY - pointerDownY) > DRAG_THRESHOLD) {
			dragMoved = true;
		}
		panX = t.clientX - dragStartX;
		panY = t.clientY - dragStartY;
	}

	function onTouchEnd() {
		isPanning = false;
	}

	function onWheel(e: WheelEvent) {
		e.preventDefault();
		const delta = e.deltaY > 0 ? -0.2 : 0.2;
		zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, +(zoom + delta).toFixed(2)));
	}
</script>

<div class="board">
	<div class="floor-panel">
		<div class="floor-meta">
			<div class="floor-meta-label">{visible.band.label}</div>
			<div class="floor-meta-sub">
				{visible.band.ways}-way picks{visible.band.floor === 3 ? ' · final' : ''}
			</div>
		</div>
		<div class="floor-tabs" role="tablist" aria-label="Floor selector">
			{#each topology.floors as f (f.floor)}
				{@const locked = lockedSet.has(f.floor)}
				<button
					type="button"
					role="tab"
					aria-selected={currentFloor === f.floor}
					class="floor-tab"
					class:active={currentFloor === f.floor}
					class:locked
					disabled={locked}
					onclick={() => switchFloor(f.floor)}
					title={locked
						? `Floor ${f.floor} · locked`
						: `Floor ${f.floor} · ${f.ways}-way picks`}
				>
					{f.floor}
				</button>
			{/each}
		</div>
	</div>

	<div class="controls">
		<button type="button" onclick={zoomIn} aria-label="Zoom in" title="Zoom in">+</button>
		<button type="button" onclick={zoomOut} aria-label="Zoom out" title="Zoom out">−</button>
		<button type="button" onclick={resetView} aria-label="Reset view" title="Reset view">⟲</button>
	</div>

	<div class="legend">
		<span class="legend-row">
			<svg class="swatch-svg" viewBox="-14 -14 28 28" width="16" height="16" aria-hidden="true">
				<rect x="-10" y="-10" width="20" height="20" rx="3" class="comm-shape" />
			</svg>
			Community
		</span>
		<span class="legend-row">
			<svg class="swatch-svg" viewBox="-14 -14 28 28" width="16" height="16" aria-hidden="true">
				<polygon
					points="-10,-4 -4,-10 4,-10 10,-4 10,4 4,10 -4,10 -10,4"
					class="path-shape"
				/>
			</svg>
			Path tile
		</span>
		<span class="legend-row">
			<svg class="swatch-svg" viewBox="-14 -14 28 28" width="16" height="16" aria-hidden="true">
				<polygon points="0,-12 11,-5 9,11 -9,11 -11,-5" class="boss-shape" />
			</svg>
			Boss
		</span>
	</div>

	<div
		class="canvas"
		class:grabbing={isPanning}
		role="presentation"
		onmousedown={onMouseDown}
		onmousemove={onMouseMove}
		onmouseup={onMouseUp}
		onmouseleave={onMouseUp}
		ontouchstart={onTouchStart}
		ontouchmove={onTouchMove}
		ontouchend={onTouchEnd}
		onwheel={onWheel}
	>
		<svg
			class="canvas-svg"
			class:panning={isPanning}
			viewBox={vbStr}
			xmlns="http://www.w3.org/2000/svg"
			style="transform: scale({zoom}) translate({panX / zoom}px, {panY / zoom}px);"
		>
			<defs>
				<radialGradient id="bossGlow" cx="50%" cy="50%" r="50%">
					<stop offset="0%" stop-color="#ff981f" stop-opacity="0.55" />
					<stop offset="70%" stop-color="#ff981f" stop-opacity="0.12" />
					<stop offset="100%" stop-color="#ff981f" stop-opacity="0" />
				</radialGradient>
			</defs>

			<g class="edges">
				{#each visible.edges as e (e.id)}
					{@const a = nodeById.get(e.from)}
					{@const b = nodeById.get(e.to)}
					{#if a && b}
						<line x1={a.x} y1={a.y} x2={b.x} y2={b.y} class="edge" />
					{/if}
				{/each}
			</g>

			{#snippet nodeBody(n: BoardNode, c: NodeContent | undefined, done: boolean)}
				{#if n.kind === 'boss'}
					<circle r="44" class="boss-aura" fill="url(#bossGlow)" />
					<polygon points="0,-30 26,-13 22,22 -22,22 -26,-13" class="boss-shape" />
					<g class="skull">
						<path
							class="skull-base"
							d="M -10,-8 C -14,-8 -14,0 -14,2 C -14,7 -11,11 -8,12 L -8,14 L -4,14 L -4,11 L 4,11 L 4,14 L 8,14 L 8,12 C 11,11 14,7 14,2 C 14,0 14,-8 10,-8 Z"
						/>
						<ellipse class="skull-socket" cx="-5" cy="2" rx="3" ry="4" />
						<ellipse class="skull-socket" cx="5" cy="2" rx="3" ry="4" />
						<path class="skull-socket" d="M -1,7 L 1,7 L 0,10 Z" />
					</g>
				{:else if n.kind === 'start' || n.kind === 'community'}
					<rect x="-22" y="-22" width="44" height="44" rx="6" class="comm-shape" />
					<path
						class="flame"
						d="M 0,-12 C -5,-7 -6,-3 -3,1 C -4,4 -1,8 0,7 C 1,8 4,4 3,1 C 6,-3 5,-7 0,-12 Z"
					/>
					{#if n.kind === 'start'}
						<text y="-32" text-anchor="middle" class="start-label">START</text>
					{/if}
				{:else}
					<polygon points="-17,-7 -7,-17 7,-17 17,-7 17,7 7,17 -7,17 -17,7" class="path-shape" />
					{#if !c}
						<text y="6" text-anchor="middle" class="path-glyph">?</text>
					{/if}
				{/if}

				{#if done}
					<g class="done-badge" transform="translate(15,-15)">
						<circle r="8" class="done-bg" />
						<path class="done-check" d="M -3.5,0 L -1,2.5 L 3.5,-3" />
					</g>
				{/if}

				{#if c}
					<foreignObject
						x="-62"
						y={n.kind === 'boss' ? 26 : n.kind === 'path' ? 18 : 24}
						width="124"
						height="34"
						class="label-fo"
					>
						<div class="node-label" xmlns="http://www.w3.org/1999/xhtml">{c.name}</div>
					</foreignObject>
				{/if}
			{/snippet}

			<g class="nodes">
				{#each visible.nodes as n (n.id)}
					{@const c = content[n.id]}
					{@const done = !!doneByTile[n.id]}
					{#if c}
						<g
							class="node {n.kind} interactive"
							class:done
							transform="translate({n.x},{n.y})"
							role="button"
							tabindex={0}
							aria-label={c.name}
							onclick={() => handleNodeClick(n.id)}
							onkeydown={(e) => handleNodeKey(e, n.id)}
						>
							{@render nodeBody(n, c, done)}
						</g>
					{:else}
						<g class="node {n.kind}" class:done transform="translate({n.x},{n.y})">
							{@render nodeBody(n, c, done)}
						</g>
					{/if}
				{/each}
			</g>
		</svg>
	</div>
</div>

<style>
	.board {
		position: relative;
		width: 100%;
		height: min(78vh, 760px);
		background:
			radial-gradient(ellipse 60% 40% at 50% 50%, rgba(255, 152, 31, 0.05) 0%, transparent 70%),
			var(--surface-alt);
		border: 1px solid var(--border);
		border-radius: var(--radius);
		overflow: hidden;
		touch-action: none;
		user-select: none;
	}

	.floor-panel {
		position: absolute;
		top: 12px;
		left: 12px;
		z-index: 4;
		display: flex;
		flex-direction: column;
		gap: 6px;
		padding: 8px 10px;
		background: rgba(0, 0, 0, 0.6);
		border: 1px solid var(--border);
		border-radius: var(--radius);
	}

	.floor-meta {
		display: flex;
		flex-direction: column;
		gap: 1px;
		line-height: 1;
	}

	.floor-meta-label {
		font-family: var(--font-heading);
		font-size: 1.1rem;
		color: var(--accent);
		letter-spacing: 1px;
		text-shadow: var(--ts);
	}

	.floor-meta-sub {
		font-family: var(--font-body);
		font-size: 0.7rem;
		color: var(--muted);
		letter-spacing: 1.5px;
		text-transform: uppercase;
		text-shadow: var(--ts);
	}

	.floor-tabs {
		display: flex;
		gap: 4px;
	}

	.floor-tab {
		min-width: 36px;
		min-height: 32px;
		height: 32px;
		padding: 0 10px;
		font-family: var(--font-heading);
		font-size: 1rem;
		background: transparent;
		border: 1px solid transparent;
		color: var(--muted);
		text-shadow: var(--ts);
	}

	.floor-tab:hover {
		color: var(--accent);
		background: var(--accent-soft);
		border-color: transparent;
	}

	.floor-tab.active {
		color: var(--accent);
		background: var(--accent-soft);
		border-color: var(--accent);
	}

	.floor-tab.locked,
	.floor-tab.locked:hover {
		color: var(--muted-soft);
		background: transparent;
		border-color: transparent;
		cursor: not-allowed;
		opacity: 0.55;
	}

	.controls {
		position: absolute;
		top: 12px;
		right: 12px;
		z-index: 4;
		display: flex;
		flex-direction: column;
		gap: 6px;
	}

	.controls button {
		width: 36px;
		height: 36px;
		min-height: 0;
		padding: 0;
		font-family: var(--font-heading);
		font-size: 1.15rem;
		display: flex;
		align-items: center;
		justify-content: center;
		background: rgba(0, 0, 0, 0.6);
		border-color: var(--accent);
	}

	.controls button:hover {
		background: var(--accent-soft);
	}

	.legend {
		position: absolute;
		bottom: 12px;
		left: 12px;
		z-index: 4;
		display: flex;
		flex-direction: column;
		gap: 5px;
		padding: 8px 10px;
		background: rgba(0, 0, 0, 0.6);
		border: 1px solid var(--border);
		border-radius: var(--radius);
		font-size: 0.8rem;
		font-family: var(--font-body);
		color: var(--muted);
		pointer-events: none;
		text-shadow: var(--ts);
	}

	.legend-row {
		display: flex;
		align-items: center;
		gap: 7px;
	}

	.swatch-svg {
		flex-shrink: 0;
		overflow: visible;
	}

	.canvas {
		width: 100%;
		height: 100%;
		cursor: grab;
	}

	.canvas.grabbing {
		cursor: grabbing;
	}

	.canvas-svg {
		width: 100%;
		height: 100%;
		display: block;
		transform-origin: 50% 50%;
		transition: transform 0.08s ease-out;
	}

	.canvas-svg.panning {
		transition: none;
	}

	.edge {
		stroke: var(--accent);
		stroke-width: 1.75;
		stroke-dasharray: 3 4;
		stroke-linecap: round;
		opacity: 0.4;
		fill: none;
	}

	.path-shape {
		fill: var(--surface-alt);
		stroke: rgba(255, 152, 31, 0.45);
		stroke-width: 1.5;
	}

	.path-glyph {
		font-family: var(--font-heading);
		fill: var(--yellow);
		font-size: 20px;
		opacity: 0.55;
	}

	.comm-shape {
		fill: var(--surface);
		stroke: var(--accent);
		stroke-width: 2;
	}

	.flame {
		fill: var(--accent);
		opacity: 0.95;
	}

	.start-label {
		font-family: var(--font-heading);
		fill: var(--yellow);
		font-size: 12px;
		letter-spacing: 2px;
	}

	.boss-shape {
		fill: #2a1814;
		stroke: var(--accent);
		stroke-width: 2.5;
	}

	.boss-aura {
		animation: bossPulse 2.6s ease-in-out infinite;
	}

	@keyframes bossPulse {
		0%,
		100% {
			opacity: 0.5;
		}
		50% {
			opacity: 1;
		}
	}

	.skull-base {
		fill: #d8c5a8;
		opacity: 0.9;
	}

	.skull-socket {
		fill: #0a0805;
	}

	.node {
		pointer-events: none;
	}

	.node.interactive {
		pointer-events: auto;
		cursor: pointer;
	}

	.node.interactive:focus-visible {
		outline: none;
	}

	.node.interactive:hover .path-shape,
	.node.interactive:focus-visible .path-shape {
		fill: var(--accent-soft);
		stroke: var(--accent);
	}

	.node.interactive:hover .comm-shape,
	.node.interactive:focus-visible .comm-shape,
	.node.interactive:hover .boss-shape,
	.node.interactive:focus-visible .boss-shape {
		stroke: var(--yellow);
	}

	.label-fo {
		overflow: visible;
		pointer-events: none;
	}

	.node-label {
		font-family: var(--font-body);
		font-size: 8.5px;
		line-height: 1.05;
		text-align: center;
		color: var(--text);
		text-shadow: 1px 1px 2px #000, 0 0 3px #000;
		overflow: hidden;
		display: -webkit-box;
		-webkit-line-clamp: 2;
		line-clamp: 2;
		-webkit-box-orient: vertical;
		word-break: break-word;
	}

	.done-badge {
		pointer-events: none;
	}

	.done-bg {
		fill: var(--success);
		stroke: #0a0805;
		stroke-width: 1;
	}

	.done-check {
		fill: none;
		stroke: #fff;
		stroke-width: 2;
		stroke-linecap: round;
		stroke-linejoin: round;
	}

	@media (prefers-reduced-motion: reduce) {
		.boss-aura {
			animation: none;
		}

		.canvas-svg {
			transition: none;
		}
	}
</style>
