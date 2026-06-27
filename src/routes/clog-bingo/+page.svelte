<script lang="ts">
	import { enhance } from '$app/forms';
	import ItemIcon from '$lib/ItemIcon.svelte';
	import { formatEhb } from '$lib/ehb';
	import type { PageData, ActionData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	let board = $derived(data.board);

	// Create-form state. Defaults: 5×5, mid difficulty.
	let size = $state(5);
	let difficulty = $state(5);
	let generating = $state(false);
	let refreshing = $state(false);
	// When a board already exists, the regenerate form is hidden until requested.
	let showRegen = $state(false);

	const DIFF_LABELS = ['', 'Casual', 'Easy', 'Easy+', 'Light', 'Moderate', 'Spicy', 'Hard', 'Hard+', 'Brutal', 'Insane'];
	let diffLabel = $derived(DIFF_LABELS[difficulty] ?? 'Moderate');

	// Completed bingo lines (rows / cols / diagonals) from the obtained tiles.
	let lines = $derived.by(() => {
		if (!board) return { count: 0, cells: new Set<number>() };
		const n = board.size;
		const got = new Set(board.tiles.filter((t) => t.obtained).map((t) => t.idx));
		const cells = new Set<number>();
		let count = 0;
		const mark = (idxs: number[]) => {
			if (idxs.every((i) => got.has(i))) {
				count++;
				idxs.forEach((i) => cells.add(i));
			}
		};
		for (let r = 0; r < n; r++) mark(Array.from({ length: n }, (_, c) => r * n + c));
		for (let c = 0; c < n; c++) mark(Array.from({ length: n }, (_, r) => r * n + c));
		mark(Array.from({ length: n }, (_, i) => i * n + i));
		mark(Array.from({ length: n }, (_, i) => i * n + (n - 1 - i)));
		return { count, cells };
	});

	let obtainedCount = $derived(board ? board.tiles.filter((t) => t.obtained).length : 0);
</script>

<svelte:head><title>Collection Log Bingo · Volition</title></svelte:head>

<section class="wrap">
	<header class="head">
		<h1>Collection Log Bingo</h1>
		<p class="muted">
			Generate a personal PVM bingo board from collection-log items you don't have yet —
			balanced by EHB so every board runs from quick tiles to grindy ones. Tiles tick off
			automatically as your collection log fills in.
		</p>
	</header>

	{#if !data.rsn}
		<div class="panel notice">
			<p>Set your <strong>OSRS RSN</strong> on your <a href="/me">profile</a> first — we read your
				collection log from TempleOSRS to know which items you're missing.</p>
		</div>
	{/if}

	{#if form?.error}
		<div class="panel error">{form.error}</div>
	{/if}
	{#if form?.refreshed}
		<div class="panel ok">
			{#if form.newlyObtained?.length}
				🎉 Marked obtained: {form.newlyObtained.join(', ')}.
			{:else}
				No new items since last check — keep grinding!
			{/if}
		</div>
	{/if}

	<!-- ── Create / regenerate form ── -->
	{#if !board || showRegen}
		<form
			method="POST"
			action="?/generate"
			class="panel generator"
			use:enhance={() => {
				generating = true;
				return async ({ update }) => {
					await update({ reset: false });
					generating = false;
					showRegen = false;
				};
			}}
		>
			<h2>{board ? 'Generate a new board' : 'Create your board'}</h2>
			{#if board}
				<p class="muted small">This replaces your current board.</p>
			{/if}

			<div class="controls">
				<div class="field">
					<span class="label">Grid size</span>
					<div class="sizes">
						{#each Array.from({ length: data.sizeRange.max - data.sizeRange.min + 1 }, (_, i) => data.sizeRange.min + i) as s}
							<label class="size-opt" class:on={size === s}>
								<input type="radio" name="size" value={s} bind:group={size} />
								{s}×{s}
							</label>
						{/each}
					</div>
				</div>

				<div class="field">
					<span class="label">Difficulty — <strong>{diffLabel}</strong></span>
					<input
						class="slider"
						type="range"
						name="difficulty"
						min={data.difficultyRange.min}
						max={data.difficultyRange.max}
						step="1"
						bind:value={difficulty}
					/>
					<div class="slider-ends"><span>Easier items</span><span>Rarer items</span></div>
					<p class="muted small">
						Higher difficulty pulls in rarer drops; every board still runs easy → hard.
					</p>
				</div>
			</div>

			<div class="actions">
				<button type="submit" class="primary" disabled={generating || !data.rsn}>
					{generating ? 'Reading your collection log…' : board ? 'Regenerate' : 'Generate board'}
				</button>
				{#if board}
					<button type="button" class="ghost" onclick={() => (showRegen = false)}>Cancel</button>
				{/if}
			</div>
		</form>
	{/if}

	<!-- ── The board ── -->
	{#if board}
		<div class="boardbar">
			<div class="stats">
				<span class="stat"><strong>{obtainedCount}</strong> / {board.tiles.length} obtained</span>
				<span class="stat"><strong>{lines.count}</strong> bingo{lines.count === 1 ? '' : 's'}</span>
				<span class="stat muted">{board.size}×{board.size} · {DIFF_LABELS[board.difficulty]}</span>
			</div>
			<div class="bar-actions">
				<form
					method="POST"
					action="?/refresh"
					use:enhance={() => {
						refreshing = true;
						return async ({ update }) => {
							await update({ reset: false });
							refreshing = false;
						};
					}}
				>
					<button type="submit" disabled={refreshing}>
						{refreshing ? 'Checking…' : '↻ Check collection log'}
					</button>
				</form>
				{#if !showRegen}
					<button type="button" class="ghost" onclick={() => (showRegen = true)}>New board</button>
				{/if}
			</div>
		</div>

		<div class="grid" style="--n:{board.size}">
			{#each board.tiles as tile (tile.idx)}
				<div
					class="tile"
					class:obtained={tile.obtained}
					class:inline={lines.cells.has(tile.idx)}
					title="{tile.item_name} · {formatEhb(tile.ehb)} at {tile.source}"
				>
					<div class="icon"><ItemIcon item={tile.item_name} size={42} /></div>
					<div class="name">{tile.item_name}</div>
					<div class="ehb">{formatEhb(tile.ehb)}</div>
					{#if tile.obtained}<div class="check">✓</div>{/if}
				</div>
			{/each}
		</div>
		<p class="muted small foot">
			EHB = efficient hours to obtain at the cheapest source. Tiles auto-complete from your
			TempleOSRS collection log — hit <em>Check collection log</em> after a drop.
		</p>
	{/if}
</section>

<style>
	.wrap {
		max-width: 920px;
		margin: 0 auto;
	}
	.head h1 {
		margin: 0 0 0.3rem;
	}
	.head p {
		max-width: 60ch;
	}
	.muted {
		color: var(--muted);
	}
	.small {
		font-size: 0.85rem;
	}
	.panel {
		background-color: var(--stone-fill);
		background-image: var(--stone-tile);
		background-repeat: repeat;
		border: 4px solid transparent;
		border-image: url('/osrs/border-tiny.png') 4 / 4px round;
		border-radius: 4px;
		padding: 1rem 1.2rem;
		margin: 1rem 0;
	}
	.notice {
		border-image: none;
		border: 1px solid var(--accent);
	}
	.error {
		border-image: none;
		border: 1px solid var(--danger);
		color: #ffd0cb;
	}
	.ok {
		border-image: none;
		border: 1px solid var(--success);
		color: #c9f7c9;
	}
	.generator h2 {
		margin: 0 0 0.4rem;
		font-size: 1.2rem;
	}
	.controls {
		display: flex;
		flex-wrap: wrap;
		gap: 1.5rem;
		margin: 0.8rem 0 1rem;
	}
	.field {
		flex: 1;
		min-width: 240px;
	}
	.label {
		display: block;
		margin-bottom: 0.4rem;
		font-size: 0.9rem;
		color: var(--accent);
	}
	.sizes {
		display: flex;
		gap: 0.4rem;
	}
	.size-opt {
		flex: 1;
		text-align: center;
		padding: 0.5rem 0;
		background: #2f281c;
		border: 9px solid transparent;
		border-image: url('/osrs/button.png') 9 / 9px stretch;
		border-radius: 5px;
		cursor: pointer;
		opacity: 0.8;
		font-family: var(--font-heading);
	}
	.size-opt.on {
		background: #4d4336;
		color: var(--accent);
		opacity: 1;
	}
	.size-opt input {
		display: none;
	}
	.slider {
		width: 100%;
		accent-color: var(--accent);
		padding: 0;
		min-height: 0;
		background: none;
		border: none;
	}
	.slider-ends {
		display: flex;
		justify-content: space-between;
		font-size: 0.75rem;
		color: var(--muted);
	}
	.actions {
		display: flex;
		gap: 0.6rem;
		align-items: center;
	}
	.ghost {
		background: transparent;
		border: 1px solid var(--border);
		border-image: none;
	}
	.boardbar {
		display: flex;
		justify-content: space-between;
		align-items: center;
		flex-wrap: wrap;
		gap: 0.75rem;
		margin: 1.25rem 0 0.75rem;
	}
	.stats {
		display: flex;
		gap: 1rem;
		flex-wrap: wrap;
		align-items: baseline;
	}
	.stat {
		font-size: 0.95rem;
	}
	.stat strong {
		color: var(--yellow);
		font-family: var(--font-heading);
		font-size: 1.15rem;
	}
	.bar-actions {
		display: flex;
		gap: 0.5rem;
	}
	.grid {
		display: grid;
		grid-template-columns: repeat(var(--n), 1fr);
		gap: 0.5rem;
	}
	.tile {
		position: relative;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: flex-start;
		gap: 0.25rem;
		padding: 0.6rem 0.4rem;
		min-height: 7rem;
		text-align: center;
		background-color: #241d12;
		background-image: var(--stone-tile);
		background-repeat: repeat;
		background-blend-mode: multiply;
		border: 4px solid transparent;
		border-image: url('/osrs/border-tiny.png') 4 / 4px round;
		border-radius: 4px;
	}
	.tile.obtained {
		background-color: #1e2a17;
	}
	.tile.inline {
		box-shadow: 0 0 0 2px var(--accent), 0 0 14px -2px var(--accent);
	}
	.tile .icon {
		display: flex;
		align-items: center;
		justify-content: center;
		height: 44px;
	}
	.tile .name {
		font-size: 0.78rem;
		line-height: 1.1;
		color: var(--text);
		overflow-wrap: anywhere;
	}
	.tile .ehb {
		font-size: 0.72rem;
		color: var(--muted);
		font-family: var(--font-heading);
	}
	.tile.obtained .name,
	.tile.obtained .ehb {
		opacity: 0.55;
	}
	.tile .check {
		position: absolute;
		top: 0.25rem;
		right: 0.35rem;
		color: var(--success);
		font-weight: bold;
		font-size: 1.1rem;
		text-shadow: 1px 1px #000;
	}
	.foot {
		margin-top: 0.75rem;
	}
</style>
