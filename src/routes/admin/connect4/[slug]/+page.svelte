<script lang="ts">
	import { enhance } from '$app/forms';
	import { invalidateAll } from '$app/navigation';
	import { onMount } from 'svelte';
	import Connect4Board from '$lib/connect4/Connect4Board.svelte';
	import Connect4Board3D, { type HoverInfo } from '$lib/connect4/Connect4Board3D.svelte';
	import WikiImage from '$lib/WikiImage.svelte';
	import { itemImageUrl, monsterImageUrl } from '$lib/wikiImage';
	import { columnLabel } from '$lib/connect4/rules';
	import { formatEhb } from '$lib/ehb';
	import { Playback, loadSeen, saveSeen, paceFor } from '$lib/connect4/playback.svelte';

	let { data, form } = $props();

	const game = $derived(data.game);
	const runCells = $derived(new Set(data.runCells));
	const pieceIds = $derived(game.pieces.map((p) => p.id as string));

	// ── playback ──────────────────────────────────────────────────────────────
	// Whatever landed since this browser last watched the board falls into place, in the
	// order it was claimed. The baseline is the LAST VISIT (localStorage), not this page
	// load, so coming back to a board that moved on shows you what you missed instead of
	// silently swapping it.
	const playback = new Playback();
	let speed = $state(1);
	let replaying = $state(false);

	// The board this effect last acted on. Without it the effect re-runs on its own writes
	// (and on every poll that changes nothing), and the second run — finding nothing fresh,
	// because the first run had already banked the ids — cancels the run it just started.
	let handled = '';

	$effect(() => {
		const ids = pieceIds;
		const slug = game.slug;
		if (replaying) return; // a manual replay owns the board until it finishes

		const key = ids.join('|');
		if (key === handled) return;
		handled = key;

		// The baseline is what this browser has SEEN, which outlives the page — a reload is
		// exactly the "I came back and refreshed" case, so it must not reset the baseline.
		const seen = loadSeen(slug);
		const fresh = ids.filter((id) => !seen.has(id));
		if (fresh.length && fresh.length < ids.length) {
			// The new pieces are the tail of the list; start the run where they begin. The
			// ids are banked when the run ENDS, so a run cut short by a reload replays.
			playback.play(ids, ids.length - fresh.length, paceFor(fresh.length, speed));
		} else {
			// Nothing new, or a board this browser has never seen at all — a first visit
			// should show the board as it stands, not replay the entire event unasked.
			playback.showAll(ids.length);
			saveSeen(slug, ids);
		}
	});

	// Bank the board once a run has played out, so the next visit only shows what is new
	// after it.
	$effect(() => {
		if (playback.settled(pieceIds.length) && pieceIds.length) saveSeen(game.slug, pieceIds);
	});

	function replayAll() {
		replaying = true;
		playback.play(pieceIds, 0, paceFor(pieceIds.length, speed));
	}
	function stopReplay() {
		replaying = false;
		playback.skip(pieceIds.length);
		saveSeen(game.slug, pieceIds);
	}
	$effect(() => {
		// A run that reaches the end releases the board back to live updates.
		if (replaying && !playback.playing) {
			replaying = false;
			saveSeen(game.slug, pieceIds);
		}
	});

	let selected = $state<number | null>(null);
	const selectedTile = $derived(selected === null ? null : (game.live[selected] ?? null));

	// ── 2D / 3D ───────────────────────────────────────────────────────────────
	// The two boards take the same props and are driven by the same playback clock, so the
	// choice is purely how it looks. Remembered, because it's a preference, not a mode.
	const VIEW_KEY = 'vs_c4_view';
	let view = $state<'flat' | '3d'>('flat');
	onMount(() => {
		try {
			if (localStorage.getItem(VIEW_KEY) === '3d') view = '3d';
		} catch {
			/* storage unavailable — flat is the safe default */
		}
	});
	function setView(v: 'flat' | '3d') {
		view = v;
		try {
			localStorage.setItem(VIEW_KEY, v);
		} catch {
			/* ignore */
		}
	}

	// The 3D board raycasts its own hover and reports it here; the flat board draws its own
	// card. A 3D hover can be a placed PIECE (what claimed that cell) or a floating TOKEN
	// (what is still on offer above that column), so this card renders both.
	let hover3d = $state<HoverInfo | null>(null);
	const claimedVia = (p: { drop_key?: string }) =>
		p.drop_key?.startsWith('manual:') ? 'credited by hand' : p.drop_key?.startsWith('test-') ? 'simulated' : 'from a Dink drop';

	// Team assignment panel
	let filter = $state('');
	let picked = $state<Set<string>>(new Set());
	const shownRoster = $derived(
		data.roster.filter((r) => !filter || (r.rsn ?? '').toLowerCase().includes(filter.toLowerCase()))
	);
	function toggle(id: string) {
		const next = new Set(picked);
		if (next.has(id)) next.delete(id);
		else next.add(id);
		picked = next;
	}

	// Pool curation
	let poolFilter = $state('');
	let poolPicked = $state<Set<number>>(new Set());
	const shownCandidates = $derived(
		data.candidates.filter(
			(c) =>
				!poolFilter ||
				c.item_name.toLowerCase().includes(poolFilter.toLowerCase()) ||
				(c.source ?? '').toLowerCase().includes(poolFilter.toLowerCase())
		)
	);
	function togglePool(id: number) {
		const next = new Set(poolPicked);
		if (next.has(id)) next.delete(id);
		else next.add(id);
		poolPicked = next;
	}

	// A shared race-y board goes stale the moment the other clan gets a drop, so unlike
	// Battleship (where an auto-reload would throw away an armed bomb) this page polls.
	let refreshedAt = $state<string>('');
	let polling = $state(true);
	async function refresh() {
		await invalidateAll();
		refreshedAt = new Date().toLocaleTimeString();
	}
	onMount(() => {
		refreshedAt = new Date().toLocaleTimeString();
		const id = setInterval(() => {
			// Don't pull the board out from under a replay that's mid-run.
			if (polling && game.phase === 'live' && !playback.playing) refresh();
		}, 10_000);
		return () => {
			clearInterval(id);
			playback.stop();
		};
	});

	const members = $derived(game.sides.flatMap((s) => s.members));
</script>

<svelte:head><title>{game.name} — Connect Four</title></svelte:head>

<div class="page">
	<header>
		<div>
			<a href="/admin/connect4" class="back">← All games</a>
			<h1>{game.name}</h1>
		</div>
		<div class="head-right">
			<span class="osrs-badge">{game.phase}</span>
			{#if game.test}<span class="osrs-badge test">test</span>{/if}
			<button type="button" onclick={refresh}>Refresh</button>
			{#if refreshedAt}<span class="muted tiny">updated {refreshedAt}</span>{/if}
		</div>
	</header>

	{#if form?.error}<p class="err">{form.error}</p>{/if}
	{#if form?.claim}
		<p class="ok">
			Claimed {form.claim.cell} for {game.sides[form.claim.side - 1]?.name} — {form.claim.tile}
			{#if form.claim.runs}<strong> · {form.claim.runs} scoring run{form.claim.runs > 1 ? 's' : ''}!</strong>{/if}
		</p>
	{/if}
	{#if form?.simulated}
		<p class="ok">
			Simulated a {form.simulated.item} drop for {form.simulated.rsn} — {form.simulated.credited} credited.
		</p>
	{/if}
	{#if form?.undone}<p class="ok">Removed the piece at {form.undone}.</p>{/if}
	{#if form?.resynced}<p class="ok">Allowlist resynced ({form.resynced.added} added, {form.resynced.removed} removed).</p>{/if}

	<!-- ── standings ─────────────────────────────────────────────────────── -->
	<section class="scores">
		{#each game.sides as side, i (side.side)}
			{@const st = game.standings[i]}
			<div class="score" style="--c: {side.color}" class:winner={game.winner === side.side}>
				<div class="score-head">
					<span class="chip"></span>
					<strong>{side.name}</strong>
					<span class="muted tiny">{side.members.length} players</span>
				</div>
				<div class="total">{st.total.toLocaleString()}</div>
				<div class="muted tiny">
					{st.tiles} tiles ({st.tilePoints.toLocaleString()}) · lines {st.linePoints.toLocaleString()}
					{#if st.longest >= 4} · longest {st.longest} in a row{/if}
				</div>
			</div>
		{/each}
	</section>

	<!-- ── the board ─────────────────────────────────────────────────────── -->
	<section class="osrs-panel board-panel">
		<div class="osrs-titlebar">
			The board — {game.pieces.length} / {data.deckSize} claimed
		</div>
		<div class="pad">
			{#if game.phase === 'setup'}
				<p class="muted">
					The board opens when the game starts. Curate {data.deckSize} tiles and put at least one
					member on a side first.
				</p>
			{:else}
				<div class="playbar">
					{#if playback.playing}
						<button type="button" onclick={stopReplay}>Skip to the end</button>
						<span class="muted tiny">
							{(playback.revealed ?? 0) - playback.from} of {playback.to - playback.from} landing…
						</span>
						<span class="progress" aria-hidden="true">
							<span
								class="progress-fill"
								style="width: {playback.to > playback.from
									? (((playback.revealed ?? 0) - playback.from) / (playback.to - playback.from)) * 100
									: 100}%"
							></span>
						</span>
					{:else}
						<button type="button" onclick={replayAll} disabled={!game.pieces.length}>
							▶ Replay the whole event
						</button>
						<label class="tiny">
							speed
							<select bind:value={speed}>
								<option value={1}>1×</option>
								<option value={2}>2×</option>
								<option value={4}>4×</option>
								<option value={8}>8×</option>
							</select>
						</label>
						<span class="muted tiny">{game.pieces.length} claims</span>
					{/if}
					<span class="viewtoggle">
						<button type="button" class:on={view === 'flat'} onclick={() => setView('flat')}>Flat</button>
						<button type="button" class:on={view === '3d'} onclick={() => setView('3d')}>3D</button>
					</span>
				</div>

				{#if view === '3d'}
					<Connect4Board3D
						pieces={game.pieces}
						live={game.live}
						sideColors={game.sides.map((s) => s.color)}
						{runCells}
						revealed={playback.revealed}
						falling={playback.falling}
						{selected}
						onselect={(c) => (selected = selected === c ? null : c)}
						onhover={(info) => (hover3d = info)}
					/>
				{:else}
					<Connect4Board
						pieces={game.pieces}
						live={game.live}
						sideColors={game.sides.map((s) => s.color)}
						sideNames={game.sides.map((s) => s.name)}
						{runCells}
						revealed={playback.revealed}
						falling={playback.falling}
						{selected}
						onselect={(c) => (selected = selected === c ? null : c)}
					/>
				{/if}

				{#if selectedTile}
					<div class="tile-detail">
						<WikiImage src={itemImageUrl(selectedTile.tile.item_name)} alt="" size={40} />
						<div>
							<strong>{columnLabel(selectedTile.col)} — {selectedTile.tile.item_name}</strong>
							<div class="muted tiny">
								{#if selectedTile.tile.source}
									<WikiImage src={monsterImageUrl(selectedTile.tile.source)} alt="" size={16} />
									{selectedTile.tile.source}
								{/if}
								{#if selectedTile.tile.ehb} · {formatEhb(selectedTile.tile.ehb)} to obtain{/if}
							</div>
						</div>
						{#if game.phase === 'live'}
							<form method="POST" action="?/credit" use:enhance class="inline">
								<input type="hidden" name="col" value={selectedTile.col} />
								{#each game.sides as s (s.side)}
									<button type="submit" name="side" value={s.side} style="--c: {s.color}" class="credit">
										Credit {s.name}
									</button>
								{/each}
							</form>
						{/if}
					</div>
				{:else if game.phase === 'live'}
					<p class="muted tiny hint">Click a tile above the board to see it and credit it by hand.</p>
				{/if}
			{/if}
		</div>
	</section>

	{#if hover3d}
		<div class="hovercard" style="left: {hover3d.x}px; top: {hover3d.y}px;" role="tooltip">
			{#if hover3d.kind === 'piece'}
				{@const p = hover3d.piece}
				<div class="hc-head" style="--c: {game.sides[p.side - 1]?.color ?? '#888'}">
					<WikiImage src={itemImageUrl(p.item_name ?? '')} alt="" size={34} />
					<div class="hc-name">
						<strong>{p.item_name ?? 'Unknown drop'}</strong>
						<span class="hc-sub">
							{columnLabel(p.col)}{p.row + 1} · {game.sides[p.side - 1]?.name ?? `side ${p.side}`}
						</span>
					</div>
				</div>
				<div class="hc-meta">
					{#if p.source}<div>from <strong>{p.source}</strong></div>{/if}
					{#if p.by_rsn}<div>by <strong>{p.by_rsn}</strong></div>{/if}
					<div class="hc-via">{claimedVia(p)}</div>
				</div>
			{:else}
				{@const t = hover3d.tile}
				<div class="hc-head" style="--c: var(--accent)">
					<WikiImage src={itemImageUrl(t.tile.item_name)} alt="" size={34} />
					<div class="hc-name">
						<strong>{t.tile.item_name}</strong>
						<span class="hc-sub">column {columnLabel(t.col)} · still up for grabs</span>
					</div>
				</div>
				<div class="hc-meta">
					{#if t.tile.source}<div>from <strong>{t.tile.source}</strong></div>{/if}
					{#if t.tile.ehb}<div class="hc-via">{formatEhb(t.tile.ehb)} to obtain</div>{/if}
				</div>
			{/if}
		</div>
	{/if}

	<!-- ── setup: the tile pool ──────────────────────────────────────────── -->
	{#if game.phase === 'setup'}
		<section class="osrs-panel">
			<div class="osrs-titlebar">Tile pool — {data.poolCount} / {data.deckSize} chosen</div>
			<div class="pad">
				<p class="muted tiny">
					One curated tile per cell of the board. They're dealt into a shuffled deck when the game
					starts: each column gets its own slice, and claiming the tile on top reveals the next one.
				</p>
				<div class="row">
					<form method="POST" action="?/autoPool" use:enhance>
						<button type="submit">Auto-fill {data.deckSize} across the difficulty range</button>
					</form>
					<input placeholder="Filter items or bosses…" bind:value={poolFilter} />
					<span class="muted tiny">{poolPicked.size} ticked</span>
				</div>

				<form method="POST" action="?/setPool" use:enhance>
					<div class="candidates">
						{#each shownCandidates.slice(0, 400) as c (c.item_id)}
							<label class="cand" class:on={poolPicked.has(c.item_id)}>
								<input
									type="checkbox"
									name="itemId"
									value={c.item_id}
									checked={poolPicked.has(c.item_id)}
									onchange={() => togglePool(c.item_id)}
								/>
								<WikiImage src={itemImageUrl(c.item_name)} alt="" size={22} />
								<span class="cand-name">{c.item_name}</span>
								<span class="muted tiny">{c.source} · {formatEhb(c.ehb)}</span>
							</label>
						{/each}
					</div>
					{#if shownCandidates.length > 400}
						<p class="muted tiny">Showing the first 400 of {shownCandidates.length} — filter to narrow.</p>
					{/if}
					<button type="submit" disabled={poolPicked.size !== data.deckSize}>
						Use these {poolPicked.size} tiles
					</button>
				</form>
			</div>
		</section>
	{/if}

	<!-- ── teams ─────────────────────────────────────────────────────────── -->
	<section class="osrs-panel">
		<div class="osrs-titlebar">Teams</div>
		<div class="pad">
			<div class="row">
				<input placeholder="Filter by RSN…" bind:value={filter} />
				<span class="muted tiny">{picked.size} selected</span>
				<form method="POST" action="?/assign" use:enhance class="inline">
					{#each [...picked] as id (id)}<input type="hidden" name="userId" value={id} />{/each}
					{#each game.sides as s (s.side)}
						<button type="submit" name="side" value={s.side} disabled={!picked.size} style="--c: {s.color}" class="credit">
							→ {s.name}
						</button>
					{/each}
					<button type="submit" name="side" value="none" disabled={!picked.size}>Remove</button>
				</form>
			</div>

			<div class="roster">
				{#each shownRoster.slice(0, 300) as r (r.id)}
					<label class="member" class:on={picked.has(r.id)}>
						<input type="checkbox" checked={picked.has(r.id)} onchange={() => toggle(r.id)} />
						<span>{r.rsn}</span>
						{#if r.side}
							<span class="pill" style="--c: {game.sides[r.side - 1].color}">{game.sides[r.side - 1].name}</span>
						{/if}
					</label>
				{/each}
			</div>
			{#if shownRoster.length > 300}
				<p class="muted tiny">Showing the first 300 of {shownRoster.length} — filter to narrow.</p>
			{/if}
		</div>
	</section>

	<!-- ── running the game ──────────────────────────────────────────────── -->
	<section class="osrs-panel">
		<div class="osrs-titlebar">Run the game</div>
		<div class="pad row wrap">
			{#if game.phase === 'setup'}
				<form method="POST" action="?/start" use:enhance>
					<button type="submit">Deal the deck and start</button>
				</form>
			{/if}
			{#if game.phase === 'live'}
				<form method="POST" action="?/simulate" use:enhance class="inline">
					<label class="tiny">
						Simulate a drop for
						<select name="userId">
							{#each members as m (m.userId)}<option value={m.userId}>{m.rsn}</option>{/each}
						</select>
					</label>
					<label class="tiny">
						column
						<select name="col">
							{#each game.live as slot, col (col)}
								{#if slot}<option value={col}>{columnLabel(col)} — {slot.tile.item_name}</option>{/if}
							{/each}
						</select>
					</label>
					<button type="submit">Send it through the real pipeline</button>
				</form>
				<form method="POST" action="?/finish" use:enhance><button type="submit">End the game</button></form>
			{/if}
			{#if game.phase === 'finished'}
				<p class="muted">
					Finished{#if game.winner} — {game.sides[game.winner - 1].name} won{:else} — a draw{/if}.
				</p>
				<form method="POST" action="?/reopen" use:enhance><button type="submit">Reopen</button></form>
			{/if}
			<form method="POST" action="?/resync" use:enhance><button type="submit">Resync allowlist</button></form>
			<label class="tiny check"><input type="checkbox" bind:checked={polling} /> auto-refresh</label>
		</div>
	</section>

	<!-- ── scoring ───────────────────────────────────────────────────────── -->
	<section class="osrs-panel">
		<div class="osrs-titlebar">Scoring</div>
		<form method="POST" action="?/scoring" use:enhance class="pad grid">
			<p class="wide muted tiny">
				Changing these re-scores the whole board immediately — the standings are always recomputed
				from the pieces. A run only ever scores once, at its current length, so extending a four
				into a five pays the difference.
			</p>
			<label>Points per tile <input name="tile_points" type="number" value={game.scoring.tile_points} /></label>
			{#each [4, 5, 6, 7] as len, i (len)}
				<label>Run of {len} <input name="line_{len}" type="number" value={game.scoring.line_points[i]?.points ?? 0} /></label>
			{/each}
			<label>Each cell past 7 <input name="extra_per_cell" type="number" value={game.scoring.extra_per_cell} /></label>
			<div class="wide"><button type="submit">Save scoring</button></div>
		</form>
	</section>

	<!-- ── the log ───────────────────────────────────────────────────────── -->
	{#if game.pieces.length}
		<section class="osrs-panel">
			<div class="osrs-titlebar">Claims ({game.pieces.length})</div>
			<div class="table-wrap">
			<table class="osrs-table">
				<thead>
					<tr><th>Cell</th><th>Side</th><th>Tile</th><th>By</th><th>Source</th><th></th></tr>
				</thead>
				<tbody>
					{#each [...game.pieces].reverse().slice(0, 60) as p (p.id)}
						<tr>
							<td>{columnLabel(p.col)}{p.row + 1}</td>
							<td><span class="pill" style="--c: {game.sides[p.side - 1].color}">{game.sides[p.side - 1].name}</span></td>
							<td>{p.item_name}</td>
							<td>{p.by_rsn ?? '—'}</td>
							<td class="tiny muted">
								{#if p.drop_key?.startsWith('manual:')}by hand{:else if p.drop_key?.startsWith('test-')}simulated{:else}Dink{/if}
							</td>
							<td class="right">
								<form method="POST" action="?/undo" use:enhance>
									<input type="hidden" name="pieceId" value={p.id} />
									<button type="submit" class="danger tiny">Undo</button>
								</form>
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
			</div>
			<p class="muted tiny pad">Only the top piece of a column can be removed — taking one from underneath would rewrite where everything above it landed.</p>
		</section>
	{/if}
</div>

<style>
	.page {
		max-width: 82rem;
		margin: 0 auto;
		padding: 1rem;
		display: grid;
		gap: 1rem;
	}
	/* Grid items default to min-width:auto, so the board's own min-width (25 columns at
	   the phone cell floor ≈ 700px) would widen this whole column and push the page
	   sideways instead of scrolling inside the board's box. */
	.page > * {
		min-width: 0;
	}
	header {
		display: flex;
		justify-content: space-between;
		align-items: flex-end;
		gap: 1rem;
		flex-wrap: wrap;
	}
	h1 {
		margin: 0.2rem 0 0;
	}
	.back {
		font-size: 0.8rem;
		color: var(--muted);
	}
	.head-right {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		flex-wrap: wrap;
	}
	.osrs-badge.test {
		color: var(--yellow);
	}

	.scores {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(14rem, 1fr));
		gap: 0.75rem;
	}
	.score {
		border: 1px solid var(--border);
		border-left: 4px solid var(--c);
		border-radius: var(--radius);
		background: var(--surface);
		padding: 0.6rem 0.8rem;
	}
	.score.winner {
		box-shadow: 0 0 0 2px var(--accent);
	}
	.score-head {
		display: flex;
		align-items: center;
		gap: 0.4rem;
	}
	.chip {
		width: 0.9rem;
		height: 0.9rem;
		border-radius: 50%;
		background: radial-gradient(circle at 36% 30%, rgba(255, 255, 255, 0.5) 0%, transparent 45%), var(--c);
	}
	.total {
		font-family: var(--font-heading);
		font-size: 1.7rem;
		color: var(--heading);
		line-height: 1.1;
	}

	.board-panel .pad {
		padding: 0.75rem;
	}
	.tile-detail {
		display: flex;
		align-items: center;
		gap: 0.6rem;
		margin-top: 0.6rem;
		padding: 0.5rem 0.6rem;
		background: var(--surface-alt);
		border: 1px solid var(--border);
		border-radius: var(--radius);
		flex-wrap: wrap;
	}
	.hint {
		margin: 0.5rem 0 0;
	}
	.playbar {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		flex-wrap: wrap;
		margin-bottom: 0.5rem;
	}
	.progress {
		flex: 1;
		min-width: 6rem;
		height: 4px;
		background: var(--surface-alt);
		border-radius: 999px;
		overflow: hidden;
	}
	.progress-fill {
		display: block;
		height: 100%;
		background: var(--accent);
		transition: width 0.12s linear;
	}
	.viewtoggle {
		display: inline-flex;
		margin-left: auto;
	}
	.viewtoggle button {
		min-height: 0;
		padding: 0.15rem 0.6rem;
		font-size: 0.78rem;
		opacity: 0.6;
	}
	.viewtoggle button.on {
		opacity: 1;
		color: var(--accent);
	}

	/* The 3D board reports hover through a callback rather than drawing its own card, so
	   the page owns this copy. Kept identical to the flat board's. */
	.hovercard {
		position: fixed;
		z-index: 50;
		transform: translate(-50%, calc(-100% - 10px));
		pointer-events: none;
		min-width: 12rem;
		max-width: 18rem;
		padding: 0.5rem 0.6rem;
		background: var(--surface);
		border: 1px solid var(--border-strong);
		border-radius: var(--radius);
		box-shadow: var(--shadow-card);
	}
	.hc-head {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		border-left: 3px solid var(--c);
		padding-left: 0.4rem;
	}
	.hc-name {
		display: grid;
		min-width: 0;
	}
	.hc-name strong {
		color: var(--heading);
		font-size: 0.9rem;
		line-height: 1.2;
	}
	.hc-sub,
	.hc-meta {
		font-size: 0.75rem;
		color: var(--muted);
	}
	.hc-meta {
		margin-top: 0.35rem;
	}
	.hc-via {
		opacity: 0.75;
		font-style: italic;
	}

	.pad {
		padding: 0.75rem;
	}
	/* Six columns don't fit a phone: the table scrolls inside its own box rather than
	   taking the page sideways with it. */
	.table-wrap {
		overflow-x: auto;
	}
	.row {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		flex-wrap: wrap;
		margin-bottom: 0.5rem;
	}
	.row.wrap {
		margin-bottom: 0;
	}
	.inline {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		flex-wrap: wrap;
	}
	.credit {
		border-left: 4px solid var(--c);
	}

	.roster,
	.candidates {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(15rem, 1fr));
		gap: 0.25rem;
		max-height: 22rem;
		overflow-y: auto;
		padding: 0.25rem;
		background: var(--surface-alt);
		border-radius: var(--radius);
	}
	.member,
	.cand {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		padding: 0.2rem 0.35rem;
		border-radius: 3px;
		font-size: 0.85rem;
		cursor: pointer;
	}
	.member.on,
	.cand.on {
		background: var(--accent-soft);
	}
	.cand-name {
		flex: 1;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.pill {
		font-size: 0.7rem;
		padding: 0.05rem 0.4rem;
		border-radius: 999px;
		border: 1px solid var(--c);
		color: var(--c);
	}

	.grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(9rem, 1fr));
		gap: 0.6rem;
	}
	.grid .wide {
		grid-column: 1 / -1;
	}
	label {
		display: grid;
		gap: 0.2rem;
		font-size: 0.85rem;
		color: var(--muted);
	}
	label.check,
	label.tiny {
		display: flex;
		align-items: center;
		gap: 0.3rem;
	}
	.tiny {
		font-size: 0.78rem;
	}
	.muted {
		color: var(--muted);
	}
	.right {
		text-align: right;
	}
	.danger {
		color: var(--danger);
	}
	.err {
		color: var(--danger);
		background: var(--danger-bg);
		padding: 0.5rem;
		border-radius: var(--radius);
		margin: 0;
	}
	.ok {
		color: var(--success);
		background: var(--success-bg);
		padding: 0.5rem;
		border-radius: var(--radius);
		margin: 0;
	}
</style>
