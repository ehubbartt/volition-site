<script lang="ts">
	import { enhance } from '$app/forms';
	import BingoTile from '$lib/BingoTile.svelte';
	import { formatEhb } from '$lib/ehb';
	import { formatXp } from '$lib/ehp';
	import { caTierLabel } from '$lib/ca';
	import { itemImageUrl, skillImageUrl, monsterImageUrl, caTierImageUrl } from '$lib/wikiImage';
	import type { PageData, ActionData } from './$types';

	type Tile = NonNullable<PageData['board']>['tiles'][number];

	let { data, form }: { data: PageData; form: ActionData } = $props();

	let board = $derived(data.board);
	let locked = $derived(data.locked);
	let canReset = $derived(data.canReset);

	// Map a personal-board tile (item / skill / ca) onto the generic BingoTile props.
	function tileImage(t: Tile): string {
		if (t.kind === 'skill') return skillImageUrl(t.skill ?? '');
		if (t.kind === 'ca') return t.source ? monsterImageUrl(t.source) : caTierImageUrl(t.ca_tier);
		return itemImageUrl(t.item_name ?? '');
	}
	function tileName(t: Tile): string {
		return t.kind === 'skill' ? `Gain ${formatXp(t.target_xp ?? 0)}` : (t.item_name ?? '');
	}
	function tileSub(t: Tile): string {
		if (t.kind === 'skill') {
			return locked && !t.obtained && t.progress_xp != null
				? `${formatXp(t.progress_xp)} / ${formatXp(t.target_xp ?? 0)}`
				: formatEhb(t.ehb);
		}
		if (t.kind === 'ca') return `${caTierLabel(t.ca_tier)} CA`;
		return formatEhb(t.ehb);
	}
	function tileTitle(t: Tile): string {
		if (t.kind === 'skill') return `${t.skill}: gain ${formatXp(t.target_xp ?? 0)} (~${formatEhb(t.ehb)} EHP)`;
		if (t.kind === 'ca') return `Combat achievement (${caTierLabel(t.ca_tier)}): ${t.item_name}`;
		return `${t.item_name} · ${formatEhb(t.ehb)} at ${t.source}`;
	}

	// Create-form state. Defaults: 5×5, mid difficulty.
	let size = $state(5);
	let difficulty = $state(5);
	let skilling = $state(data.board?.tiles.some((t) => t.kind === 'skill') ?? false);
	let ca = $state(data.board?.tiles.some((t) => t.kind === 'ca') ?? false);
	let generating = $state(false);
	let refreshing = $state(false);
	let locking = $state(false);
	// For a LOCKED board, the regenerate form stays hidden until the owner asks to reset.
	let showRegen = $state(false);

	function fmtDate(iso: string | null): string {
		if (!iso) return '';
		try {
			return new Date(iso).toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' });
		} catch {
			return iso;
		}
	}

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

<svelte:head><title>Personal Bingo · Volition</title></svelte:head>

<section class="wrap">
	<a class="back" href="/events">← Events</a>
	<header class="head">
		<h1>Personal Bingo</h1>
		<p class="muted">
			Generate a personal PVM bingo board from collection-log items you don't have yet —
			balanced by EHB so every board runs from quick tiles to grindy ones. Reroll it as much as
			you like, then <strong>lock it in</strong> to start tracking; a locked board is yours for
			{data.lockDays} days. Tiles tick off automatically from your collection log and Dink drops.
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
				Marked obtained: {form.newlyObtained.join(', ')}.
			{:else}
				No new items since last check — keep grinding!
			{/if}
		</div>
	{/if}
	{#if form?.locked}
		<div class="panel ok">
			Board locked in — progress now tracks automatically from your collection log and Dink. You
			can make a new board on {fmtDate(data.resettableAt)}.
		</div>
	{/if}

	<!-- ── Create / reroll / reset form ── -->
	{#if !board || !locked || showRegen}
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
			<h2>{!board ? 'Create your board' : locked ? 'Generate a new board' : 'Your draft board — reroll until you like it'}</h2>
			{#if locked}
				<p class="muted small">This starts a brand-new draft (and clears your tracked progress).</p>
			{:else if board}
				<p class="muted small">Reroll as many times as you want — nothing is tracked until you lock it in.</p>
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
						Higher difficulty pulls in rarer drops (and bigger XP goals); every board still runs easy → hard.
					</p>
				</div>

				<div class="field">
					<span class="label">Skilling tiles</span>
					<label class="toggle">
						<input type="checkbox" name="skilling" bind:checked={skilling} />
						<span>Include skilling goals</span>
					</label>
				</div>

				<div class="field">
					<span class="label">Combat achievements</span>
					<label class="toggle">
						<input type="checkbox" name="ca" bind:checked={ca} />
						<span>Include combat achievements</span>
					</label>
				</div>
			</div>

			<div class="actions">
				<button type="submit" class="primary" disabled={generating || !data.rsn}>
					{generating ? 'Reading your collection log…' : !board ? 'Generate board' : locked ? 'Generate new board' : 'Reroll'}
				</button>
				{#if locked}
					<button type="button" class="ghost" onclick={() => (showRegen = false)}>Cancel</button>
				{/if}
			</div>
		</form>
	{/if}

	<!-- ── Draft: lock-in bar ── -->
	{#if board && !locked}
		<div class="panel lockbar">
			<p class="muted small">
				Happy with this board? <strong>Lock it in</strong> to start tracking — it'll be committed
				for {data.lockDays} days. Item tiles tick off from your collection log + Dink; skilling
				tiles count XP gained from now on. Progress you already had before locking doesn't count.
			</p>
			<form
				method="POST"
				action="?/lock"
				use:enhance={({ cancel }) => {
					if (!confirm(`Lock this board in for ${data.lockDays} days? You won't be able to reroll until then.`)) {
						cancel();
						return;
					}
					locking = true;
					return async ({ update }) => {
						await update({ reset: false });
						locking = false;
					};
				}}
			>
				<button type="submit" class="primary" disabled={locking}>
					{locking ? 'Locking…' : 'Lock it in'}
				</button>
			</form>
		</div>
	{/if}

	<!-- ── The board ── -->
	{#if board}
		{#if locked}
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
							{refreshing ? 'Checking…' : '↻ Check progress'}
						</button>
					</form>
					{#if canReset}
						{#if !showRegen}
							<button type="button" class="ghost" onclick={() => (showRegen = true)}>New board</button>
						{/if}
					{:else}
						<span class="muted small lock-note">Locked · new board {fmtDate(data.resettableAt)}</span>
					{/if}
				</div>
			</div>
		{/if}

		<div class="grid" style="--n:{board.size}">
			{#each board.tiles as tile (tile.idx)}
				<BingoTile
					image={tileImage(tile)}
					name={tileName(tile)}
					sub={tileSub(tile)}
					obtained={tile.obtained}
					highlighted={lines.cells.has(tile.idx)}
					title={tileTitle(tile)}
				/>
			{/each}
		</div>
		<p class="muted small foot">
				EHB/EHP = efficient hours to obtain a drop / train a skill.
				{#if locked}
					Item tiles auto-complete from your collection log + Dink; skill tiles track XP gained since you locked in (WiseOldMan); combat-achievement tiles complete when you finish the CA (WikiSync) — hit <em>Check progress</em> to refresh.
				{:else}
					This is a <strong>draft preview</strong> — nothing is tracked until you lock it in.
				{/if}
			</p>
	{/if}
</section>

<style>
	.wrap {
		max-width: 920px;
		margin: 0 auto;
	}
	.back {
		display: inline-block;
		margin-bottom: 0.6rem;
		color: var(--accent);
		text-decoration: none;
		font-size: 0.9rem;
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
	.lockbar {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
		flex-wrap: wrap;
		border-image: none;
		border: 1px solid var(--accent);
	}
	.lockbar p {
		margin: 0;
		flex: 1;
		min-width: 16rem;
	}
	.lock-note {
		white-space: nowrap;
		align-self: center;
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
	.toggle {
		display: flex;
		align-items: center;
		gap: 0.45rem;
		cursor: pointer;
		font-size: 0.9rem;
	}
	.toggle input {
		width: auto;
		min-height: 0;
		accent-color: var(--accent);
	}
	.grid {
		display: grid;
		grid-template-columns: repeat(var(--n), 1fr);
		gap: 0.5rem;
	}
	/* Individual tiles are the reusable <BingoTile> component ($lib/BingoTile.svelte). */
	.foot {
		margin-top: 0.75rem;
	}
</style>
