<script lang="ts">
	import { onMount } from 'svelte';
	import type { BoardNode, BoardTopology } from './topology';
	import type { NodeState, NodeProgress } from './progress';

	interface NodeContent {
		name: string;
		img: string | null;
		faq_html: string | null;
	}

	// Where to auto-center the board on load (the team's current tile/section).
	interface FocusTarget {
		floor: number;
		x: number; // viewBox coords (topology space)
		y: number;
		zoom?: number;
	}

	let {
		topology,
		lockedFloors = [2, 3],
		content = {},
		nodeState = {},
		nodeProgress = {},
		teamMarkers = {},
		focus = null,
		onNodeClick
	}: {
		topology: BoardTopology;
		lockedFloors?: number[];
		content?: Record<string, NodeContent>;
		nodeState?: Record<string, NodeState>;
		nodeProgress?: Record<string, NodeProgress>;
		// nodeId -> the top-ranked teams whose current position is that node (their names sit
		// beside the tile). Names/ranks only — no tile content.
		teamMarkers?: Record<string, { rank: number; name: string }[]>;
		focus?: FocusTarget | null;
		onNodeClick?: (id: string) => void;
	} = $props();

	const MIN_ZOOM = 0.5;
	const MAX_ZOOM = 5;
	const PAD = 40;
	const DRAG_THRESHOLD = 5;
	const FOCUS_ZOOM = 1.7;

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
	let svgEl: SVGSVGElement;

	// On load, jump the view to the team's current tile/section (see `focus`). Centers
	// the focus point in the viewport and zooms in. Runs ONCE on mount so it never
	// fights the user's own panning after an action re-renders the board.
	function applyFocus() {
		if (!focus || !svgEl) return;
		const W = svgEl.clientWidth;
		const H = svgEl.clientHeight;
		if (!W || !H) {
			requestAnimationFrame(applyFocus); // layout not settled yet
			return;
		}
		const band = topology.floors.find((f) => f.floor === focus.floor) ?? topology.floors[0];
		// The viewBox the SVG renders for this floor (mirrors vbStr) — used to map the
		// focus point (topology coords) into element pixels via the meet-fit scale.
		const minX = -PAD;
		const vbW = topology.viewBox.w + PAD * 2;
		const minY = band.y - 12;
		const vbH = band.height + 24;
		const s = Math.min(W / vbW, H / vbH); // preserveAspectRatio xMidYMid meet scale
		const Z = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, focus.zoom ?? FOCUS_ZOOM));
		// Transform is scale(Z) translate(panX/Z, panY/Z) about the element centre, so a
		// point's screen offset = Z·local + pan; solve pan so the focus point lands centre.
		currentFloor = focus.floor;
		zoom = Z;
		panX = -Z * s * (focus.x - (minX + vbW / 2));
		panY = -Z * s * (focus.y - (minY + vbH / 2));
	}

	onMount(applyFocus);

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

	// Structural cues so the three SECTIONS of one floor don't read as three floors: a light
	// dotted bracket down the LEFT side of each section with its letter (A/B/C) in the middle,
	// plus a small "Intermission" tag on each mid tile.
	const sectionBrackets = $derived.by(() => {
		const out: { section: string; top: number; bottom: number; x: number }[] = [];
		for (const sec of ['A', 'B', 'C'] as const) {
			const ns = visible.nodes.filter((n) => n.section === sec);
			if (!ns.length) continue;
			const ys = ns.map((n) => n.y);
			const xs = ns.map((n) => n.x);
			out.push({
				section: sec,
				top: Math.min(...ys) - 30,
				bottom: Math.max(...ys) + 30,
				x: Math.min(...xs) - 74 // left of the leftmost lane + its name label
			});
		}
		return out;
	});
	const midNodes = $derived(visible.nodes.filter((n) => n.id.includes('-mid-')));

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
			<div class="floor-meta-label">{visible.band.label} <span class="floor-of">of {topology.floors.length}</span></div>
			<div class="floor-meta-sub">Sections A · B · C → Boss</div>
		</div>
		<span class="floor-tabs-hint">Switch floor</span>
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
			bind:this={svgEl}
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

			{#snippet nodeBody(n: BoardNode, c: NodeContent | undefined, done: boolean, rejected: boolean)}
				{#if n.kind === 'boss'}
					<circle r="56" class="boss-aura" fill="url(#bossGlow)" />
					<polygon points="0,-39 34,-17 29,29 -29,29 -34,-17" class="boss-shape" />
					{#if c?.img}
						<image
							class="node-img"
							href={c.img}
							x="-27"
							y="-27"
							width="54"
							height="54"
							preserveAspectRatio="xMidYMid meet"
						/>
					{:else}
						<g class="skull">
							<path
								class="skull-base"
								d="M -10,-8 C -14,-8 -14,0 -14,2 C -14,7 -11,11 -8,12 L -8,14 L -4,14 L -4,11 L 4,11 L 4,14 L 8,14 L 8,12 C 11,11 14,7 14,2 C 14,0 14,-8 10,-8 Z"
							/>
							<ellipse class="skull-socket" cx="-5" cy="2" rx="3" ry="4" />
							<ellipse class="skull-socket" cx="5" cy="2" rx="3" ry="4" />
							<path class="skull-socket" d="M -1,7 L 1,7 L 0,10 Z" />
						</g>
					{/if}
				{:else if n.kind === 'start' || n.kind === 'community'}
					<rect x="-25" y="-25" width="50" height="50" rx="7" class="comm-shape" />
					{#if c?.img}
						<image
							class="node-img"
							href={c.img}
							x="-19"
							y="-19"
							width="38"
							height="38"
							preserveAspectRatio="xMidYMid meet"
						/>
					{:else}
						<path
							class="flame"
							d="M 0,-14 C -6,-8 -7,-3 -3,1 C -5,5 -1,9 0,8 C 1,9 5,5 3,1 C 7,-3 6,-8 0,-14 Z"
						/>
					{/if}
					{#if n.kind === 'start'}
						<text y="-37" text-anchor="middle" class="start-label">START</text>
					{/if}
				{:else}
					<polygon points="-23,-9 -9,-23 9,-23 23,-9 23,9 9,23 -9,23 -23,9" class="path-shape" />
					{#if c?.img}
						<image
							class="node-img"
							href={c.img}
							x="-17"
							y="-17"
							width="34"
							height="34"
							preserveAspectRatio="xMidYMid meet"
						/>
					{:else if !c}
						<text y="7" text-anchor="middle" class="path-glyph">?</text>
					{/if}
				{/if}

				{#if done}
					<g class="done-badge" transform="translate(18,-18)">
						<circle r="9.5" class="done-bg" />
						<path class="done-check" d="M -4,0 L -1.5,3 L 4,-3.5" />
					</g>
				{/if}

				{#if rejected}
					<g class="reject-badge" transform="translate(-18,-18)">
						<circle r="9.5" class="reject-bg" />
						<path class="reject-x" d="M -3.3,-3.3 L 3.3,3.3 M 3.3,-3.3 L -3.3,3.3" />
					</g>
				{/if}

				{#if c}
					{@const p = nodeProgress[n.id]}
					<foreignObject
						x="-61"
						y={n.kind === 'boss' ? 36 : n.kind === 'path' ? 26 : 30}
						width="122"
						height="50"
						class="label-fo"
					>
						<div class="node-label-wrap" xmlns="http://www.w3.org/1999/xhtml">
							<div class="node-label">{c.name}</div>
							{#if p && (p.required > 1 || p.pending > 0)}
								<div class="node-prog">
									<span class:full={p.approved >= p.required}>{p.approved}/{p.required}</span>
									{#if p.pending > 0}<span class="node-prog-pending">+{p.pending}</span>{/if}
								</div>
							{/if}
						</div>
					</foreignObject>
				{/if}
			{/snippet}

			<g class="nodes">
				{#each visible.nodes as n (n.id)}
					{@const c = content[n.id]}
					{@const st = nodeState[n.id]}
					{@const done = st === 'complete'}
					{@const p = nodeProgress[n.id]}
					{@const rejected =
						st === 'active' && !!p && p.rejected > 0 && p.approved + p.pending < p.required}
					{#if c}
						<g
							class="node {n.kind} interactive"
							class:done
							class:choosable={st === 'choosable'}
							class:active={st === 'active'}
							class:dimmed={st === 'dimmed'}
							class:rejected
							transform="translate({n.x},{n.y})"
							role="button"
							tabindex={0}
							aria-label={c.name}
							onclick={() => handleNodeClick(n.id)}
							onkeydown={(e) => handleNodeKey(e, n.id)}
						>
							{@render nodeBody(n, c, done, rejected)}
						</g>
					{:else}
						<g class="node {n.kind}" transform="translate({n.x},{n.y})">
							{@render nodeBody(n, c, false, false)}
						</g>
					{/if}
				{/each}
			</g>

			<!-- Section brackets (left side) + intermission tags — make a floor's structure clear. -->
			<g class="structure-labels">
				{#each sectionBrackets as b (b.section)}
					{@const mid = (b.top + b.bottom) / 2}
					<line class="sec-bracket" x1={b.x} y1={b.top} x2={b.x} y2={mid - 13} />
					<line class="sec-bracket" x1={b.x} y1={mid + 13} x2={b.x} y2={b.bottom} />
					<line class="sec-bracket" x1={b.x} y1={b.top} x2={b.x + 10} y2={b.top} />
					<line class="sec-bracket" x1={b.x} y1={b.bottom} x2={b.x + 10} y2={b.bottom} />
					<text class="sec-letter" x={b.x} y={mid} text-anchor="middle" dominant-baseline="central">
						{b.section}
					</text>
				{/each}
				{#each midNodes as n (n.id)}
					<foreignObject x={n.x - 70} y={n.y - 47} width="140" height="18" class="struct-fo">
						<div class="mid-header" xmlns="http://www.w3.org/1999/xhtml">Intermission</div>
					</foreignObject>
				{/each}
			</g>

			<!-- Top-team name tags beside their current tile (subtle, non-interactive). -->
			<g class="team-markers">
				{#each visible.nodes as n (n.id)}
					{#if teamMarkers[n.id]?.length}
						{@const ms = teamMarkers[n.id]}
						<foreignObject x={n.x + 24} y={n.y - 20} width="118" height="64" class="marker-fo">
							<div class="marker-wrap" xmlns="http://www.w3.org/1999/xhtml">
								{#each ms.slice(0, 3) as m (m.rank)}
									<span class="marker-chip"><b>{m.rank}</b> {m.name}</span>
								{/each}
								{#if ms.length > 3}
									<span class="marker-more">+{ms.length - 3} more</span>
								{/if}
							</div>
						</foreignObject>
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
		font-size: 1.4rem;
		color: var(--accent);
		letter-spacing: 1px;
		text-transform: uppercase;
		text-shadow: var(--ts);
	}

	.floor-of {
		font-size: 0.85rem;
		color: var(--muted);
		text-transform: none;
	}

	.floor-meta-sub {
		font-family: var(--font-body);
		font-size: 0.7rem;
		color: var(--muted);
		letter-spacing: 1px;
		text-transform: uppercase;
		text-shadow: var(--ts);
	}

	.floor-tabs-hint {
		font-family: var(--font-body);
		font-size: 0.62rem;
		letter-spacing: 1.5px;
		text-transform: uppercase;
		color: var(--muted-soft, var(--muted));
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
		font-size: 26px;
		opacity: 0.55;
	}

	.node-img {
		filter: drop-shadow(0 1px 1px rgba(0, 0, 0, 0.85));
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
		font-size: 13px;
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

	/* Progression states (player view) */
	.node.dimmed {
		opacity: 0.4;
	}

	.node.active .path-shape,
	.node.active .comm-shape,
	.node.active .boss-shape {
		stroke: var(--accent);
		stroke-width: 3;
		filter: drop-shadow(0 0 4px rgba(255, 152, 31, 0.7));
	}

	.node.choosable .path-shape,
	.node.choosable .comm-shape {
		stroke: var(--yellow);
		stroke-width: 2.5;
		animation: choosablePulse 1.8s ease-in-out infinite;
	}

	@keyframes choosablePulse {
		0%,
		100% {
			filter: drop-shadow(0 0 1px rgba(240, 210, 60, 0.4));
		}
		50% {
			filter: drop-shadow(0 0 6px rgba(240, 210, 60, 0.95));
		}
	}

	/* Rejected → needs redo. Overrides the active orange with a pulsing red ring (placed
	   after .node.active so it wins on the same specificity). */
	.node.rejected .path-shape,
	.node.rejected .comm-shape,
	.node.rejected .boss-shape {
		stroke: var(--danger);
		stroke-width: 3;
		animation: rejectPulse 1.3s ease-in-out infinite;
	}

	@keyframes rejectPulse {
		0%,
		100% {
			filter: drop-shadow(0 0 2px rgba(229, 72, 77, 0.6));
		}
		50% {
			filter: drop-shadow(0 0 7px rgba(229, 72, 77, 1));
		}
	}

	.reject-badge {
		pointer-events: none;
	}

	.reject-bg {
		fill: var(--danger);
		stroke: #0a0805;
		stroke-width: 1;
	}

	.reject-x {
		fill: none;
		stroke: #fff;
		stroke-width: 2.2;
		stroke-linecap: round;
	}

	/* Section / intermission dividers — make a floor's internal structure unmistakable. */
	.struct-fo {
		overflow: visible;
		pointer-events: none;
	}

	.sec-bracket {
		stroke: rgba(240, 210, 60, 0.45);
		stroke-width: 1.2;
		stroke-dasharray: 1.5 4;
		stroke-linecap: round;
		fill: none;
	}

	.sec-letter {
		fill: var(--yellow);
		opacity: 0.8;
		font-family: var(--font-heading);
		font-size: 21px;
		paint-order: stroke;
		stroke: rgba(0, 0, 0, 0.7);
		stroke-width: 3px;
	}

	.mid-header {
		text-align: center;
		font-family: var(--font-body);
		font-size: 9px;
		letter-spacing: 2px;
		text-transform: uppercase;
		color: var(--muted);
		text-shadow: 1px 1px 2px #000, 0 0 3px #000;
	}

	/* Top-team name tags — kept deliberately subtle so they read as annotations, not clutter. */
	.marker-fo {
		overflow: visible;
		pointer-events: none;
	}

	.marker-wrap {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 2px;
	}

	.marker-chip {
		max-width: 116px;
		padding: 0 4px;
		font-family: var(--font-body);
		font-size: 8.5px;
		line-height: 1.4;
		color: rgba(255, 255, 255, 0.82);
		background: rgba(0, 0, 0, 0.6);
		border: 1px solid rgba(255, 152, 31, 0.4);
		border-radius: 3px;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.marker-chip b {
		color: var(--yellow);
		font-family: var(--font-heading);
		margin-right: 2px;
	}

	.marker-more {
		padding: 0 4px;
		font-size: 8px;
		color: var(--muted);
		text-shadow: 1px 1px 1px #000;
	}

	.label-fo {
		overflow: visible;
		pointer-events: none;
	}

	.node-label-wrap {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 1px;
	}

	.node-label {
		font-family: var(--font-body);
		font-size: 10px;
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

	.node-prog {
		font-family: var(--font-heading);
		font-size: 9px;
		line-height: 1;
		color: var(--yellow);
		text-shadow: 1px 1px 2px #000;
		display: flex;
		gap: 3px;
	}

	.node-prog .full {
		color: var(--success);
	}

	.node-prog-pending {
		color: var(--accent);
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
		stroke-width: 2.3;
		stroke-linecap: round;
		stroke-linejoin: round;
	}

	@media (prefers-reduced-motion: reduce) {
		.boss-aura {
			animation: none;
		}

		.node.choosable .path-shape,
		.node.choosable .comm-shape {
			animation: none;
		}

		.node.rejected .path-shape,
		.node.rejected .comm-shape,
		.node.rejected .boss-shape {
			animation: none;
			filter: drop-shadow(0 0 4px rgba(229, 72, 77, 0.9));
		}

		.canvas-svg {
			transition: none;
		}
	}
</style>
