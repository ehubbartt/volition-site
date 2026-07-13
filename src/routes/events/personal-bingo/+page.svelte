<script lang="ts">
	import { enhance } from '$app/forms';
	import BingoTile from '$lib/BingoTile.svelte';
	import WikiImage from '$lib/WikiImage.svelte';
	import TileSubmitModal from '$lib/TileSubmitModal.svelte';
	import { formatEhb } from '$lib/ehb';
	import { formatXp } from '$lib/ehp';
	import { caTierLabel } from '$lib/ca';
	import { itemImageUrl, skillImageUrl, monsterImageUrl, caTierImageUrl, wikiPageUrl } from '$lib/wikiImage';
	import Skeleton from '$lib/Skeleton.svelte';
	import { swrResource } from '$lib/swrResource.svelte';
	import type { PageData, ActionData } from './$types';

	type PB = NonNullable<PageData['pb']['cached']>;
	type Tile = NonNullable<PB['board']>['tiles'][number];

	let { data: pageData, form }: { data: PageData; form: ActionData } = $props();

	// The board payload is a stale-while-revalidate pair (see +page.ts): revisits
	// seed from the last board this browser saw, the background refetch swaps in
	// fresh completion state, and first-ever visits show the skeleton grid below.
	// Shadowed under the old `data` name so every reference keeps working.
	const EMPTY_PB = {
		rsn: null,
		board: null,
		vp: null,
		dropRates: {},
		locked: false,
		resettableAt: null,
		canReset: false,
		lockDays: 0,
		sizeRange: { min: 3, max: 7 },
		difficultyRange: { min: 1, max: 10 }
	} as unknown as PB;
	// Seed the regen-form toggles from the board's actual composition the first
	// time fresh data arrives (their $state initializers ran before the data existed).
	let toggled = false;
	const pbRes = swrResource(() => pageData.pb, EMPTY_PB, {
		onFresh: (p) => {
			if (!toggled && p.board) {
				toggled = true;
				skilling = p.board.tiles.some((t) => t.kind === 'skill');
				ca = p.board.tiles.some((t) => t.kind === 'ca');
				includeOwned = p.board.tiles.some((t) => t.kind === 'item' && t.match_type === 'loot');
			}
		}
	});
	const data = $derived({
		...pbRes.value,
		rsn: pbRes.ready ? pbRes.value.rsn : (pageData.user?.rsn ?? null)
	});
	const pbReady = $derived(pbRes.ready);

	let board = $derived(data.board);
	let locked = $derived(data.locked);
	let canReset = $derived(data.canReset);

	// TEMPORARY: busy flag for the admin-only easy-test-board generator.
	let generatingTest = $state(false);

	// Map a personal-board tile (item / skill / ca) onto the generic BingoTile props.
	function tileImage(t: Tile): string {
		if (t.kind === 'skill') return skillImageUrl(t.skill ?? '');
		if (t.kind === 'ca') return t.source ? monsterImageUrl(t.source) : caTierImageUrl(t.ca_tier);
		return itemImageUrl(t.item_name ?? '');
	}
	function tileName(t: Tile): string {
		return t.kind === 'skill' ? `Gain ${formatXp(t.target_xp ?? 0)}` : (t.item_name ?? '');
	}
	// TEMPORARY: shipping without per-tile EHB/EHP numbers (sub-line + hover) — flip to
	// re-enable. The tile-detail modal keeps its EHB row either way.
	const SHOW_TILE_EHB = false;

	function tileSub(t: Tile): string {
		if (t.pending && !t.obtained) return 'Pending review';
		if (t.rejected && !t.obtained) return 'Rejected — resubmit?';
		if (t.kind === 'skill') {
			return locked && !t.obtained && t.progress_xp != null
				? `${formatXp(t.progress_xp)} / ${formatXp(t.target_xp ?? 0)}`
				: SHOW_TILE_EHB
					? formatEhb(t.ehb)
					: '';
		}
		if (t.kind === 'ca') return `${caTierLabel(t.ca_tier)} CA`;
		return SHOW_TILE_EHB ? formatEhb(t.ehb) : '';
	}
	function tileTitle(t: Tile): string {
		if (t.kind === 'skill') {
			return SHOW_TILE_EHB
				? `${t.skill}: gain ${formatXp(t.target_xp ?? 0)} (~${formatEhb(t.ehb)} EHP)`
				: `${t.skill}: gain ${formatXp(t.target_xp ?? 0)}`;
		}
		if (t.kind === 'ca') return `Combat achievement (${caTierLabel(t.ca_tier)}): ${t.item_name}`;
		return SHOW_TILE_EHB
			? `${t.item_name} · ${formatEhb(t.ehb)} at ${t.source}`
			: `${t.item_name} · ${t.source}`;
	}

	// Tile-detail modal: shown for tiles with nothing to submit (obtained/pending/draft).
	let modalTile = $state<Tile | null>(null);
	const modalHeading = $derived(
		modalTile ? (modalTile.kind === 'skill' ? (modalTile.skill ?? 'Skill') : (modalTile.item_name ?? '')) : ''
	);

	// Manual-submission modal (reusable <TileSubmitModal>), opened from the detail modal.
	let submitTarget = $state<Tile | null>(null);
	function tileHeading(t: Tile): string {
		return t.kind === 'skill' ? (t.skill ?? 'Skill') : (t.item_name ?? 'Tile');
	}

	// Create-form state. Defaults: 5×5, mid difficulty.
	let size = $state(5);
	let difficulty = $state(5);
	let skilling = $state(false); // re-seeded from the board when it arrives (onFresh)
	let ca = $state(false);
	let pets = $state(true); // pets are included by default; unchecking filters pet drops out
	let skip99 = $state(false); // skilling sub-option: skip skills already at level 99
	let includeOwned = $state(false); // allow already-owned clog items (as drop-again loot tiles)
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

	// Completed bingo lines (rows / cols / diagonals) from the obtained tiles. `keys`
	// mirrors the server's award keys (r0.., c0.., d0, d1) and drives the VP gutter chips.
	let lines = $derived.by(() => {
		if (!board) return { count: 0, cells: new Set<number>(), keys: new Set<string>() };
		const n = board.size;
		const got = new Set(board.tiles.filter((t) => t.obtained).map((t) => t.idx));
		const cells = new Set<number>();
		const keys = new Set<string>();
		let count = 0;
		const mark = (key: string, idxs: number[]) => {
			if (idxs.every((i) => got.has(i))) {
				count++;
				keys.add(key);
				idxs.forEach((i) => cells.add(i));
			}
		};
		for (let r = 0; r < n; r++) mark(`r${r}`, Array.from({ length: n }, (_, c) => r * n + c));
		for (let c = 0; c < n; c++) mark(`c${c}`, Array.from({ length: n }, (_, r) => r * n + c));
		mark('d0', Array.from({ length: n }, (_, i) => i * n + i));
		mark('d1', Array.from({ length: n }, (_, i) => i * n + (n - 1 - i)));
		return { count, cells, keys };
	});

	let obtainedCount = $derived(board ? board.tiles.filter((t) => t.obtained).length : 0);
</script>

<svelte:head><title>Personal Bingo · Volition</title></svelte:head>
<svelte:window onkeydown={(e) => { if (e.key === 'Escape') modalTile = null; }} />

<section class="wrap">
	<a class="back" href="/events">← Events</a>
	<header class="head">
		<h1>Personal Bingo</h1>
		<p class="muted">
			Generate a personal PVM bingo board from collection-log items you don't have yet —
			balanced by EHB so every board runs from quick tiles to grindy ones. Reroll it as much as
			you like, then <strong>lock it in</strong> to start tracking; a locked board is yours for
			{data.lockDays} days. Tiles tick off automatically from your collection log and Dink drops
			— set up <a href="/temple-guide">Temple</a> and <a href="/dink-check">Dink</a> once and
			you're covered.
		</p>
	</header>

	{#if !pbReady}
		<!-- Payload still streaming in — 5x5 tile-skeleton grid holds the layout. -->
		<div class="pb-skeleton">
			<Skeleton height="3rem" radius="8px" />
			<div class="pb-skeleton-grid">
				{#each { length: 25 }, i (i)}
					<Skeleton height="7rem" radius="10px" />
				{/each}
			</div>
		</div>
	{:else}
	{#if !data.rsn}
		<div class="panel notice">
			<p>Set your <strong>OSRS RSN</strong> on your <a href="/me">profile</a> first — we read your
				collection log from TempleOSRS to know which items you're missing. New to Temple? Follow
				the <a href="/temple-guide">Temple setup guide</a> (2 minutes).</p>
		</div>
	{/if}

	{#if form?.error}
		<div class="panel error">
			{form.error}
			{#if form.error.includes('TempleOSRS')}
				<a href="/temple-guide">Temple setup guide →</a>
			{:else if form.error.includes('WikiSync')}
				<a
					href="https://runelite.net/plugin-hub/show/wikisync"
					target="_blank"
					rel="noreferrer noopener">Get the WikiSync plugin ↗</a
				>
			{/if}
		</div>
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
	{#if form?.submitted}
		<div class="panel ok">
			Submitted for review — the tile will tick off once an admin approves it.
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
					<span class="label">Settings</span>
					<label class="toggle">
						<input type="checkbox" name="skilling" bind:checked={skilling} />
						<span>Include skilling goals</span>
					</label>
					{#if skilling}
						<label class="toggle sub">
							<input type="checkbox" name="skip99" bind:checked={skip99} />
							<span>Exclude maxed skills</span>
						</label>
					{/if}
					<label class="toggle">
						<input type="checkbox" name="ca" bind:checked={ca} />
						<span>Include combat achievements</span>
					</label>
					<label class="toggle">
						<input type="checkbox" name="pets" bind:checked={pets} />
						<span>Include pets</span>
					</label>
					<!-- HIDDEN for launch: owned items must drop again to credit, but a handful of
					     clog items are once-per-account and would make a tile impossible. Re-enable
					     once a curated owned-pool exclusion list exists — the server plumbing
					     (match_type 'loot' tiles, the generator's includeOwned param) is live. -->
					{#if false}
						<label class="toggle">
							<input type="checkbox" name="owned" bind:checked={includeOwned} />
							<span>Include items I already own</span>
						</label>
						{#if includeOwned}
							<p class="muted small">
								Owned items must <strong>drop again</strong> while your board is locked (tracked
								by Dink) — your existing collection log won't tick them.
							</p>
						{/if}
					{/if}
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

	<!-- TEMPORARY (admins only): easiest-possible 3x3 for verifying Dink/XP/CA tracking
	     end to end. Rendered OUTSIDE the generator block on purpose: it must stay
	     reachable while a board is locked (the test path bypasses the lock window).
	     HIDDEN for launch (flip the false to bring it back for more testing). -->
	{#if false && pageData.isAdmin && pbReady}
		<form
			method="POST"
			action="?/generateTest"
			class="panel testgen"
			use:enhance={() => {
				generatingTest = true;
				return async ({ update }) => {
					await update({ reset: false });
					generatingTest = false;
					showRegen = false;
				};
			}}
		>
			<p class="muted small">
				<strong>Admin test:</strong> generates a 3×3 with Bones, Feather and Cowhide as plain
				loot tiles (kill a chicken/cow), 3 skill goals of 1 XP, and your 3 easiest
				uncompleted combat achievements — lock it in, then any matching drop / XP gain /
				CA completion should tick tiles off automatically.
				{#if board}<strong>Replaces your current board</strong> (even a locked one) and clears
				its progress.{/if}
			</p>
			<button type="submit" class="ghost" disabled={generatingTest || !data.rsn}>
				{generatingTest ? 'Building test board…' : 'Generate easy test board'}
			</button>
		</form>
	{/if}

	<!-- ── Draft: lock-in bar ── -->
	{#if board && !locked}
		<div class="panel lockbar">
			<p class="muted small">
				Happy with this board? <strong>Lock it in</strong> to start tracking — it'll be committed
				for {data.lockDays} days. Item tiles tick off from your collection log + Dink; skilling
				tiles count XP gained from now on. Progress you already had before locking doesn't count.
				{#if data.vp && !data.vp.test}
					Completed rows, columns and diagonals pay <strong>{data.vp.line} VP</strong> each, and
					blacking out the whole board pays a <strong>+{data.vp.blackout} VP</strong> bonus.
				{/if}
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
					{#if data.vp}
						{#if data.vp.test}
							<span class="stat muted">test board · no VP</span>
						{:else}
							<span class="stat"><strong>{data.vp.earned}</strong> VP earned</span>
							<span class="stat muted">line {data.vp.line} VP · blackout +{data.vp.blackout} VP</span>
						{/if}
					{/if}
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

		{@const showVp = !!(data.vp && !data.vp.test)}
		<!-- VP gutter: each row/column/diagonal wears a chip with its VP at the edge of the
		     board (top = columns + the two diagonals on the corners, left = rows), lighting
		     up green once that line is complete; the blackout bonus runs along the bottom. -->
		<div class="grid" class:with-vp={showVp} style="--n:{board.size}">
			{#if showVp && data.vp}
				{@const lv = data.vp.line}
				<div class="vpchip corner" class:done={lines.keys.has('d0')} style="grid-row: 1; grid-column: 1" title="Diagonal (top-left → bottom-right): {lv} VP">↘{lv}</div>
				{#each Array.from({ length: board.size }) as _, c (c)}
					<div class="vpchip" class:done={lines.keys.has(`c${c}`)} style="grid-row: 1; grid-column: {c + 2}" title="Column {c + 1}: {lv} VP">{lv}</div>
				{/each}
				<div class="vpchip corner" class:done={lines.keys.has('d1')} style="grid-row: 1; grid-column: {board.size + 2}" title="Diagonal (top-right → bottom-left): {lv} VP">↙{lv}</div>
				{#each Array.from({ length: board.size }) as _, r (r)}
					<div class="vpchip" class:done={lines.keys.has(`r${r}`)} style="grid-row: {r + 2}; grid-column: 1" title="Row {r + 1}: {lv} VP">{lv}</div>
				{/each}
				<div
					class="vpbar"
					class:done={obtainedCount === board.size * board.size}
					style="grid-row: {board.size + 2}; grid-column: 2 / span {board.size}"
					title="Complete every tile for a +{data.vp.blackout} VP bonus"
				>
					Blackout · +{data.vp.blackout} VP
				</div>
			{/if}
			{#each board.tiles as tile (tile.idx)}
				<div
					class="cell"
					style={showVp
						? `grid-row:${Math.floor(tile.idx / board.size) + 2};grid-column:${(tile.idx % board.size) + 2}`
						: undefined}
				>
					<BingoTile
						image={tileImage(tile)}
						name={tileName(tile)}
						sub={tileSub(tile)}
						obtained={tile.obtained}
						highlighted={lines.cells.has(tile.idx)}
						title={tileTitle(tile)}
						ontileclick={() => {
							// One click surface: submittable tiles open the submission modal
							// (which includes the tile's details); obtained, pending-review, and
							// draft tiles open the detail modal (status/proof, nothing to submit).
							if (locked && !tile.obtained && !tile.pending) submitTarget = tile;
							else modalTile = tile;
						}}
					/>
				</div>
			{/each}
		</div>
		<p class="muted small foot">
				{#if SHOW_TILE_EHB}EHB/EHP = efficient hours to obtain a drop / train a skill.{/if}
				{#if locked}
					Item tiles auto-complete from your collection log + Dink; skill tiles track XP gained since you locked in (WiseOldMan); combat-achievement tiles complete when you finish the CA (WikiSync) — hit <em>Check progress</em> to refresh.
					<strong>Skilling XP only updates after you log out of OSRS</strong> — the hiscores (which WiseOldMan reads) refresh on logout, so log out before checking.
				{:else}
					This is a <strong>draft preview</strong> — nothing is tracked until you lock it in.
				{/if}
			</p>
	{/if}
	{/if}
</section>

<!-- Tile details (dl + wiki links) — rendered in BOTH the detail modal (icon click) and
     inside the submission modal (whole-tile click), so the info is never a click away. -->
{#snippet tileInfo(t: Tile)}
	{#if t.kind === 'item'}
		<dl class="modal-dl">
			<div><dt>Boss</dt><dd>{t.source ?? '—'}</dd></div>
			<div><dt>Drop rate</dt><dd>{data.dropRates[t.idx] ?? '—'}</dd></div>
			<div><dt>EHB</dt><dd>{formatEhb(t.ehb)}</dd></div>
		</dl>
		<div class="modal-links">
			{#if t.source}<a href={wikiPageUrl(t.source)} target="_blank" rel="noreferrer noopener">{t.source} wiki ↗</a>{/if}
			{#if t.item_name}<a href={wikiPageUrl(t.item_name)} target="_blank" rel="noreferrer noopener">{t.item_name} wiki ↗</a>{/if}
		</div>
	{:else if t.kind === 'skill'}
		<dl class="modal-dl">
			<div><dt>Skill</dt><dd>{t.skill}</dd></div>
			<div><dt>Goal</dt><dd>Gain {formatXp(t.target_xp ?? 0)}</dd></div>
			<div><dt>≈ EHP</dt><dd>{formatEhb(t.ehb)}</dd></div>
			{#if locked && t.progress_xp != null}
				<div><dt>Progress</dt><dd>{formatXp(t.progress_xp)} / {formatXp(t.target_xp ?? 0)}</dd></div>
			{/if}
		</dl>
		<div class="modal-links">
			{#if t.skill}<a href={wikiPageUrl(t.skill)} target="_blank" rel="noreferrer noopener">{t.skill} wiki ↗</a>{/if}
		</div>
	{:else}
		<dl class="modal-dl">
			<div><dt>Combat achievement</dt><dd>{t.item_name}</dd></div>
			<div><dt>Tier</dt><dd>{caTierLabel(t.ca_tier)}</dd></div>
			{#if t.source}<div><dt>Boss</dt><dd>{t.source}</dd></div>{/if}
		</dl>
		<div class="modal-links">
			{#if t.source}<a href={wikiPageUrl(t.source)} target="_blank" rel="noreferrer noopener">{t.source} wiki ↗</a>{/if}
			<a href="https://oldschool.runescape.wiki/w/Combat_Achievements" target="_blank" rel="noreferrer noopener">Combat Achievements wiki ↗</a>
		</div>
	{/if}
{/snippet}

<!-- Tile-detail modal (obtained / pending-review / draft tiles — status, proof, wiki info). -->
{#if modalTile}
	{@const t = modalTile}
	<div class="modal-backdrop" role="presentation" onclick={(e) => { if (e.target === e.currentTarget) modalTile = null; }}>
		<div class="modal" role="dialog" tabindex="-1" aria-modal="true" aria-label={modalHeading}>
			<button class="modal-close" type="button" aria-label="Close" onclick={() => (modalTile = null)}>×</button>
			<div class="modal-head">
				<div class="modal-icon"><WikiImage src={tileImage(t)} size={48} /></div>
				<h3>{modalHeading}</h3>
			</div>

			{@render tileInfo(t)}

			{#if t.obtained}
				<p class="modal-done">✓ Completed{#if t.manual} · submitted manually{/if}</p>
				{#if t.proof_urls && t.proof_urls.length}
					<div class="modal-proof">
						{#each t.proof_urls as url (url)}
							<a href={url} target="_blank" rel="noreferrer noopener"><img src={url} alt="proof" /></a>
						{/each}
					</div>
				{/if}
			{:else if t.pending}
				<p class="modal-done">⏳ Submitted — awaiting admin review</p>
			{:else if t.rejected}
				<p class="modal-rejected">
					✗ Your submission was rejected{#if t.rejection_note}: “{t.rejection_note}”{/if} — you
					can submit again.
				</p>
				{#if locked}
					<button type="button" class="modal-submit" onclick={() => { submitTarget = t; modalTile = null; }}>
						Resubmit proof
					</button>
				{/if}
			{:else if locked}
				<button type="button" class="modal-submit" onclick={() => { submitTarget = t; modalTile = null; }}>
					Mark done / submit proof
				</button>
			{/if}
		</div>
	</div>
{/if}

<!-- Manual tile submission (reusable component), with the tile's details inline. -->
{#if submitTarget}
	{@const st = submitTarget}
	<TileSubmitModal
		tile={{ id: st.idx, name: tileHeading(st), img: tileImage(st) }}
		submitUrl="?/submitTile"
		note="Add a screenshot as proof (optional), then submit to mark this tile complete."
		submitLabel="Mark done"
		onclose={() => (submitTarget = null)}
	>
		{@render tileInfo(st)}
		{#if st.rejected}
			<p class="modal-rejected">
				✗ Your previous submission was rejected{#if st.rejection_note}: “{st.rejection_note}”{/if}.
			</p>
		{/if}
	</TileSubmitModal>
{/if}

<style>
	.pb-skeleton {
		display: flex;
		flex-direction: column;
		gap: 1rem;
	}

	.pb-skeleton-grid {
		display: grid;
		grid-template-columns: repeat(5, 1fr);
		gap: 0.5rem;
	}

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
	/* Uniform stat chips: one height, one type scale, numbers highlighted inline — the
	   previous mix of large heading numerals and plain/muted text sat at ragged heights. */
	.stats {
		display: flex;
		gap: 0.5rem;
		flex-wrap: wrap;
		align-items: center;
	}
	.stat {
		display: inline-flex;
		align-items: center;
		gap: 0.3rem;
		height: 1.9rem;
		padding: 0 0.65rem;
		border-radius: 999px;
		background: rgba(0, 0, 0, 0.24);
		box-shadow: inset 0 0 0 1.5px #5c4d35;
		font-family: var(--font-heading);
		font-size: 0.78rem;
		line-height: 1;
		color: #cbb78b;
		white-space: nowrap;
	}
	.stat strong {
		color: var(--yellow);
		font-family: var(--font-heading);
		font-size: 0.92rem;
		line-height: 1;
	}
	.stat.muted {
		color: var(--muted);
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
	/* Stacked toggles under the single "Settings" label get a little breathing room. */
	.toggle + .toggle {
		margin-top: 0.4rem;
	}
	/* Sub-option nested under its parent toggle (e.g. "Skip skills already at 99"). */
	.toggle.sub {
		margin-left: 1.5rem;
		font-size: 0.82rem;
		color: var(--muted);
	}
	.toggle input {
		width: auto;
		min-height: 0;
		accent-color: var(--accent);
	}
	.grid {
		display: grid;
		/* minmax(0, 1fr) lets the columns shrink below the tiles' content width so the board
		   always fits the viewport (tiles scale their icon/text via container queries). */
		grid-template-columns: repeat(var(--n), minmax(0, 1fr));
		gap: 0.5rem;
		max-width: 100%;
	}
	/* With VP chips the board grows a slim gutter on the top/left/right (line chips) and a
	   bottom bar (blackout). Tiles are explicitly placed into the inner n×n window. */
	.grid.with-vp {
		grid-template-columns: minmax(1.6rem, auto) repeat(var(--n), minmax(0, 1fr)) minmax(1.6rem, auto);
	}
	.cell {
		min-width: 0;
		display: grid;
	}
	.vpchip {
		align-self: center;
		justify-self: center;
		display: flex;
		align-items: center;
		justify-content: center;
		min-width: 1.8rem;
		height: 1.8rem;
		padding: 0 0.35rem;
		border-radius: 999px;
		font-family: var(--font-heading);
		font-size: 0.72rem;
		line-height: 1;
		color: #cbb78b;
		background: rgba(0, 0, 0, 0.28);
		box-shadow: inset 0 0 0 1.5px #5c4d35;
		cursor: default;
		white-space: nowrap;
	}
	.vpchip.done {
		color: #eef7e0;
		background: radial-gradient(circle at 35% 30%, #6f9c4c, #46672f);
		box-shadow:
			inset 0 0 0 1.5px rgba(24, 42, 12, 0.6),
			0 0 8px -2px var(--success);
	}
	.vpbar {
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 0.35rem 0.5rem;
		border-radius: 5px;
		font-family: var(--font-heading);
		font-size: 0.8rem;
		color: #cbb78b;
		background: rgba(0, 0, 0, 0.24);
		box-shadow: inset 0 0 0 1.5px #5c4d35;
		cursor: default;
	}
	.vpbar.done {
		color: #eef7e0;
		background: linear-gradient(165deg, #55673f, #46672f);
		box-shadow:
			inset 0 0 0 1.5px rgba(24, 42, 12, 0.6),
			0 0 10px -2px var(--success);
	}
	/* Individual tiles are the reusable <BingoTile> component ($lib/BingoTile.svelte). */
	.foot {
		margin-top: 0.75rem;
	}

	/* ── Tile-detail modal ── */
	.modal-backdrop {
		position: fixed;
		inset: 0;
		z-index: 50;
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 1rem;
		background: rgba(0, 0, 0, 0.6);
	}
	.modal {
		position: relative;
		width: 100%;
		max-width: 22rem;
		background: #2a2418;
		border: 4px solid transparent;
		border-image: url('/osrs/border-tiny.png') 4 / 4px round;
		border-radius: 6px;
		padding: 1.1rem 1.2rem 1.2rem;
	}
	.modal-close {
		position: absolute;
		top: 0.35rem;
		right: 0.5rem;
		background: none;
		border: none;
		min-height: 0;
		padding: 0.1rem 0.4rem;
		font-size: 1.3rem;
		line-height: 1;
		color: var(--muted);
		cursor: pointer;
	}
	.modal-close:hover {
		color: var(--accent);
	}
	.modal-head {
		display: flex;
		align-items: center;
		gap: 0.7rem;
		margin-bottom: 0.8rem;
	}
	.modal-icon {
		flex: none;
		display: flex;
		align-items: center;
		justify-content: center;
		width: 58px;
		height: 58px;
		border-radius: 50%;
		background: radial-gradient(circle at 50% 38%, #f1e8cf, #c3b088);
		box-shadow: inset 0 0 0 2px rgba(0, 0, 0, 0.45);
	}
	.modal-head h3 {
		margin: 0;
		font-size: 1.05rem;
		color: var(--accent);
	}
	.modal-dl {
		margin: 0 0 0.9rem;
		display: flex;
		flex-direction: column;
		gap: 0.3rem;
	}
	.modal-dl > div {
		display: flex;
		justify-content: space-between;
		gap: 1rem;
		font-size: 0.88rem;
	}
	.modal-dl dt {
		color: var(--muted);
	}
	.modal-dl dd {
		margin: 0;
		text-align: right;
		color: var(--text);
	}
	.modal-links {
		display: flex;
		flex-direction: column;
		gap: 0.35rem;
	}
	.modal-links a {
		color: var(--accent);
		font-size: 0.88rem;
	}
	.modal-done {
		margin: 0.8rem 0 0;
		color: var(--success);
		font-weight: bold;
		font-size: 0.9rem;
	}
	.modal-rejected {
		margin: 0.8rem 0 0;
		color: var(--danger, #e06666);
		font-size: 0.9rem;
	}
	.modal-submit {
		margin-top: 0.9rem;
		width: 100%;
	}
	.modal-proof {
		display: flex;
		flex-wrap: wrap;
		gap: 0.4rem;
		margin-top: 0.5rem;
	}
	.modal-proof img {
		width: 54px;
		height: 54px;
		object-fit: cover;
		border-radius: 4px;
		border: 1px solid rgba(255, 255, 255, 0.15);
	}
</style>
