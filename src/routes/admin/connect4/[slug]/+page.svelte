<script lang="ts">
	import { enhance } from '$app/forms';
	import { invalidateAll } from '$app/navigation';
	import { onMount } from 'svelte';
	import Connect4Board from '$lib/connect4/Connect4Board.svelte';
	import Connect4Board3D, { type HoverInfo } from '$lib/connect4/Connect4Board3D.svelte';
	import TileHoverCard, { type CardInfo } from '$lib/connect4/TileHoverCard.svelte';
	import WikiImage from '$lib/WikiImage.svelte';
	import { itemImageUrl, monsterImageUrl } from '$lib/wikiImage';
	import {
		ROWS,
		cellId,
		cellLabel,
		columnCounts,
		columnLabel,
		landingRow,
		runCellSet,
		standings as computeStandings,
		type LiveTile,
		type Piece,
		type TileRef
	} from '$lib/connect4/rules';
	import { formatEhb } from '$lib/ehb';
	import { Playback, loadSeen, saveSeen, paceFor } from '$lib/connect4/playback.svelte';

	let { data, form } = $props();

	const game = $derived(data.game);

	// ── the local board ───────────────────────────────────────────────────────
	// Crediting is a form POST, and the round trip plus the reload takes a couple of seconds.
	// Rather than wait — which made the board look broken — the client keeps its OWN copy of
	// what it believes is on the board and merges the server's version into it as it arrives.
	//
	// `pending` holds claims this browser has made that the server has not confirmed yet.
	// Each is superseded the moment a server piece occupies its cell, whether that news
	// arrives from the claim's own response or from the 10-second poll. That is what makes
	// rapid clicking work: the first response no longer wipes the ones still in flight, and
	// gravity for each new click is computed against the MERGED board, so the second piece
	// stacks on the first instead of fighting it for the same cell.
	let pending = $state<Piece[]>([]);
	let pendingSeq = 0;
	/** Cells this browser has already watched land, so a confirmation doesn't replay them. */
	const animatedLocally = new Set<string>();

	const serverCells = $derived(new Set(game.pieces.map((p) => cellId(p.col, p.row))));
	const livePending = $derived(pending.filter((p) => !serverCells.has(cellId(p.col, p.row))));
	const boardPieces = $derived(livePending.length ? [...game.pieces, ...livePending] : game.pieces);
	const pieceIds = $derived(boardPieces.map((p) => p.id as string));

	// THE OBJECTIVE ABOVE A CLAIMED COLUMN. The deck is deliberately withheld from the page,
	// so the client cannot work out what comes next — only the server can say. Two steps, so
	// the rail never just sits there showing a tile that has already been won:
	//
	//   0ms      the column is marked `claiming`: the objective dims and says it is being
	//            dealt, which is the honest state — claimed, replacement unknown.
	//   ~1.8s    the claim's own response carries the replacement, and it takes the slot.
	//            (The reload behind it lands ~1s later and agrees.)
	//
	// Keyed by the deckIdx of the tile that was claimed, so an entry retires itself the
	// moment the server's own payload moves that column past it.
	let dealt = $state(new Map<number, { from: number; slot: LiveTile | null }>());

	function noteDealt(col: number, from: number, tile: TileRef | null) {
		const cur = dealt.get(col);
		// Reject only strictly-older answers: five fast clicks all carry the same `from`, and
		// the last one to arrive is the one that names the tile actually on offer now.
		if (cur && cur.from > from) return;
		const next = new Map(dealt);
		next.set(col, { from, slot: tile ? { col, deckIdx: from + 1, tile } : null });
		dealt = next;
	}

	const liveTiles = $derived(
		game.live.map((slot, col) => {
			const d = dealt.get(col);
			// Only stand in while the server is still showing the tile we claimed.
			return d && slot?.deckIdx === d.from ? d.slot : slot;
		})
	);

	/** Columns claimed by this browser whose replacement the server has not named yet. */
	const claiming = $derived(
		new Set(livePending.map((p) => p.col).filter((col) => !dealt.has(col) || liveTiles[col] === game.live[col]))
	);

	// Scores and the run highlight are derived from the MERGED board, not from the server's
	// snapshot. They used to arrive with the page data, which meant the four you had just
	// completed did not light up — and the score did not move — until the round trip landed
	// or you reloaded. The rules module is pure and client-safe, so the same functions the
	// server scores with run here on every piece the board is showing.
	const standings = $derived(computeStandings(boardPieces, game.scoring));
	const runCells = $derived(runCellSet(standings.flatMap((s) => s.runs)));

	// Drop pending claims the server has now told us about. Kept out of the derived above so
	// nothing mutates state while computing it.
	$effect(() => {
		const taken = serverCells;
		if (pending.length && pending.some((p) => taken.has(cellId(p.col, p.row)))) {
			pending = pending.filter((p) => !taken.has(cellId(p.col, p.row)));
		}
	});

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
		// A piece this browser dropped itself has already been watched; the server
		// confirming it later carries a different (real) id, and without this it would
		// fall a second time.
		const fresh = ids.filter((id, i) => {
			const p = boardPieces[i];
			if (p && animatedLocally.has(cellId(p.col, p.row))) return false;
			return !seen.has(id);
		});
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

	/**
	 * Drop the piece now, before the server has confirmed it. Returns the local id so the
	 * form can retire exactly THIS claim when its own response lands — retiring all of them
	 * is what made a second fast click erase the first.
	 */
	function creditOptimistically(col: number, side: number): string | null {
		// Against the MERGED board, so a rapid second click stacks rather than colliding.
		const row = landingRow(columnCounts(boardPieces), col);
		if (row === null) return null;
		const tile = liveTiles[col]?.tile;
		const id = `pending:${++pendingSeq}`;
		const piece = {
			id,
			col,
			row,
			side: side as 1 | 2,
			deck_idx: col * ROWS + row,
			item_id: tile?.item_id ?? null,
			item_name: tile?.item_name ?? null,
			source: tile?.source ?? null,
			by_user_id: null,
			by_rsn: null,
			drop_key: 'manual:pending',
			claimed_at: new Date().toISOString()
		} satisfies Piece;
		animatedLocally.add(cellId(col, row));
		pending = [...pending, piece];

		// Read the merged list back AFTER the write — it already ends with the new piece.
		// Appending `id` by hand instead produced a list one longer than the board, whose
		// key never matched the catch-up effect's, so the effect ran, found nothing fresh
		// and called `showAll` — cancelling the drop before a single frame of it played.
		const ids = pieceIds;
		handled = ids.join('|'); // this board is ours; the catch-up effect should leave it be
		playback.play(ids, ids.length - 1, paceFor(1, speed));
		return id;
	}

	/** Retire one pending claim — used when the server rejects it, or never answers. */
	function dropPending(id: string | null) {
		if (id) pending = pending.filter((p) => p.id !== id);
	}

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
	const selectedTile = $derived(selected === null ? null : (liveTiles[selected] ?? null));

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
	// Same flag-not-cancel dance as the flat board: leaving the canvas for the card would
	// otherwise clear the hover before the pointer arrived at the wiki links.
	let overCard3d = false;
	let hide3d: ReturnType<typeof setTimeout> | null = null;
	function set3dHover(info: HoverInfo | null) {
		if (hide3d) clearTimeout(hide3d);
		if (info) hover3d = info;
		else
			hide3d = setTimeout(() => {
				if (!overCard3d) hover3d = null;
			}, 260);
	}
	const claimedVia = (p: { drop_key?: string }) =>
		p.drop_key?.startsWith('manual:') ? 'credited by hand' : p.drop_key?.startsWith('test-') ? 'simulated' : 'from a Dink drop';

	// The 3D board reports what the pointer is over; the card itself is the same component
	// the flat board uses, so both views describe a tile identically.
	const hover3dCard = $derived.by((): CardInfo | null => {
		const h = hover3d;
		if (!h) return null;
		if (h.kind === 'piece') {
			const p = h.piece;
			return {
				kind: 'piece',
				itemName: p.item_name ?? 'Unknown drop',
				source: p.source,
				where: `${columnLabel(p.col)}${p.row + 1}`,
				sideName: game.sides[p.side - 1]?.name ?? `side ${p.side}`,
				sideColor: game.sides[p.side - 1]?.color,
				byRsn: p.by_rsn,
				via: claimedVia(p),
				x: h.x,
				y: h.y
			};
		}
		return {
			kind: 'tile',
			itemName: h.tile.tile.item_name,
			source: h.tile.tile.source,
			ehb: h.tile.tile.ehb,
			where: `column ${columnLabel(h.tile.col)}`,
			x: h.x,
			y: h.y
		};
	});

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
	let selectedOnly = $state(false);
	let poolPicked = $state<Set<number>>(new Set());

	// What the event has actually SAVED. The ticks start from this — otherwise auto-fill
	// (which saves straight away) leaves a list where nothing looks chosen, and the save
	// button reads "Use these 0 tiles".
	const savedIds = $derived(new Set(game.pool.map((t) => t.item_id)));
	let handledPool = '';
	$effect(() => {
		const key = [...savedIds].sort((a, b) => a - b).join(',');
		if (key === handledPool) return;
		handledPool = key;
		poolPicked = new Set(savedIds);
	});
	// Whether the ticks differ from what is saved, so the button can say which it is.
	const poolDirty = $derived(
		poolPicked.size !== savedIds.size || [...poolPicked].some((id) => !savedIds.has(id))
	);

	const shownCandidates = $derived(
		data.candidates.filter((c) => {
			if (selectedOnly && !poolPicked.has(c.item_id)) return false;
			if (!poolFilter) return true;
			const q = poolFilter.toLowerCase();
			return c.item_name.toLowerCase().includes(q) || (c.source ?? '').toLowerCase().includes(q);
		})
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
			Claimed {cellLabel(form.claim.cell ?? '')} for {game.sides[form.claim.side - 1]?.name} — {form.claim.tile}
			{#if form.claim.runs}<strong> · {form.claim.runs} scoring run{form.claim.runs > 1 ? 's' : ''}!</strong>{/if}
		</p>
	{/if}
	{#if form?.simulated}
		<p class="ok">
			Simulated a {form.simulated.item} drop for {form.simulated.rsn} — {form.simulated.credited} credited.
		</p>
	{/if}
	{#if form?.pooled}<p class="ok">Tile pool saved — {form.pooled} tiles chosen.</p>{/if}
	{#if form?.undone}
		<p class="ok">
			Removed the piece{typeof form.undone === 'string' ? ` at ${cellLabel(form.undone)}` : ''}.
		</p>
	{/if}
	{#if form?.resynced}<p class="ok">Allowlist resynced ({form.resynced.added} added, {form.resynced.removed} removed).</p>{/if}

	<!-- ── standings ─────────────────────────────────────────────────────── -->
	<section class="scores">
		{#each game.sides as side, i (side.side)}
			{@const st = standings[i]}
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
							▶ Replay
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
						pieces={boardPieces}
						live={liveTiles}
						{claiming}
						sideColors={game.sides.map((s) => s.color)}
						{runCells}
						revealed={playback.revealed}
						falling={playback.falling}
						{selected}
						onselect={(c) => (selected = selected === c ? null : c)}
						onhover={set3dHover}
					/>
				{:else}
					<Connect4Board
						pieces={boardPieces}
						live={liveTiles}
						{claiming}
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
							<form
								method="POST"
								action="?/credit"
								class="inline"
								use:enhance={({ formData }) => {
									const col = Number(formData.get('col'));
									const from = liveTiles[col]?.deckIdx ?? null;
									const id = creditOptimistically(col, Number(formData.get('side')));
									return async ({ update, result }) => {
										// Take the replacement off the claim's OWN response, before the
										// reload behind it — that is a second the rail would otherwise
										// spend showing an objective that has already been won.
										if (result.type === 'success' && from !== null) {
											const claim = (result.data as { claim?: { replacement?: TileRef | null } } | undefined)
												?.claim;
											if (claim) noteDealt(col, from, claim.replacement ?? null);
										}
										await update({ reset: false });
										// A rejected claim has no server piece to supersede it, so retire it
										// here; a successful one is retired by the cell it now occupies.
										if (result.type !== 'success') dropPending(id);
									};
								}}
							>
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

	{#if hover3dCard}
		<TileHoverCard
			info={hover3dCard}
			onkeep={() => {
				overCard3d = true;
				if (hide3d) clearTimeout(hide3d);
			}}
			onrelease={() => {
				overCard3d = false;
				set3dHover(null);
			}}
		/>
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
					<label class="tiny check">
						<input type="checkbox" bind:checked={selectedOnly} /> chosen only
					</label>
					<span class="muted tiny">
						{poolPicked.size} ticked
						{#if poolDirty}<strong class="unsaved">· unsaved</strong>{/if}
					</span>
				</div>

				<form method="POST" action="?/setPool" use:enhance>
					<!-- The selection travels as hidden inputs, NOT as the visible checkboxes:
					     the list is filtered and capped, so submitting only what happens to be
					     on screen would quietly drop every chosen tile scrolled or filtered out
					     of view. -->
					{#each [...poolPicked] as id (id)}<input type="hidden" name="itemId" value={id} />{/each}

					<div class="candidates">
						{#each shownCandidates.slice(0, 400) as c (c.item_id)}
							<label class="cand" class:on={poolPicked.has(c.item_id)}>
								<input
									type="checkbox"
									checked={poolPicked.has(c.item_id)}
									onchange={() => togglePool(c.item_id)}
								/>
								<WikiImage src={itemImageUrl(c.item_name)} alt="" size={22} />
								<span class="cand-name">{c.item_name}</span>
								<span class="muted tiny">{c.source} · {formatEhb(c.ehb)}</span>
							</label>
						{:else}
							<p class="muted tiny pad">
								{selectedOnly ? 'Nothing chosen matches that filter.' : 'No candidates match that filter.'}
							</p>
						{/each}
					</div>
					{#if shownCandidates.length > 400}
						<p class="muted tiny">Showing the first 400 of {shownCandidates.length} — filter to narrow.</p>
					{/if}
					<button type="submit" disabled={poolPicked.size !== data.deckSize || !poolDirty}>
						{#if !poolDirty && poolPicked.size === data.deckSize}
							Saved — {data.deckSize} tiles ready
						{:else}
							Save these {poolPicked.size} tiles
						{/if}
					</button>
					{#if poolPicked.size !== data.deckSize}
						<span class="muted tiny">
							{poolPicked.size < data.deckSize
								? `${data.deckSize - poolPicked.size} more to pick`
								: `${poolPicked.size - data.deckSize} too many`}
						</span>
					{/if}
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
				<form
					method="POST"
					action="?/assign"
					class="inline"
					use:enhance={() =>
						async ({ update, result }) => {
							await update({ reset: false });
							// A seated batch must let go of the roster. Leaving it ticked means the
							// next side you click quietly takes the people you just placed with it.
							if (result.type === 'success') picked = new Set();
						}}
				>
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
							{#each liveTiles as slot, col (col)}
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
					<!-- One branch each, rather than a shared prefix: Svelte trims the leading
					     space inside a block, which rendered it as "Finished— Yellow won". -->
					{#if game.winner}Finished — {game.sides[game.winner - 1].name} won.{:else}Finished — a
						draw.{/if}
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
	/* Six columns of claims do not fit a phone. Scroll the table inside its own box —
	   without this it is wider than the viewport and takes the whole PAGE sideways. */
	.table-wrap {
		overflow-x: auto;
		overscroll-behavior-x: contain;
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

	/* Two-column-plus lists of people and candidate items. These were lost when the
	   inline hover-card styles were deleted, which turned Teams into one long column. */
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
	.unsaved {
		color: var(--yellow);
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
