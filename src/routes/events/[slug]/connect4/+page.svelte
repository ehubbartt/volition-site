<script lang="ts">
	import type { PageData } from './$types';
	import { invalidateAll } from '$app/navigation';
	import { onMount } from 'svelte';
	import { swrResource } from '$lib/swrResource.svelte';
	import Skeleton from '$lib/Skeleton.svelte';
	import Connect4Board from '$lib/connect4/Connect4Board.svelte';
	import Connect4Board3D, { type HoverInfo } from '$lib/connect4/Connect4Board3D.svelte';
	import TileHoverCard, { type CardInfo } from '$lib/connect4/TileHoverCard.svelte';
	import WikiImage from '$lib/WikiImage.svelte';
	import { itemImageUrl, monsterImageUrl } from '$lib/wikiImage';
	import {
		columnLabel,
		runCellSet,
		standings as computeStandings
	} from '$lib/connect4/rules';
	import { formatEhb } from '$lib/ehb';
	import { Playback, loadSeen, saveSeen, paceFor } from '$lib/connect4/playback.svelte';
	import { liveEvent } from '$lib/live.svelte';
	import type { Connect4PageResult } from '$lib/server/connect4Page';

	// The member board — the SPECTATOR half of the Connect Four event. The admin tester
	// (/admin/connect4/[slug]) drives the game; this page only watches it: same board,
	// same rail, same replay machinery, none of the crediting. Because nobody acts from
	// here there is no optimistic local state to protect — the server snapshot IS the
	// board, and the version poll keeps it honest (docs/LIVE-UPDATES.md).

	let { data }: { data: PageData } = $props();

	const EMPTY = { kind: 'ok', live: '', game: null } as unknown as Connect4PageResult;
	const res = swrResource(() => data.connect4, EMPTY);
	const payload = $derived(res.value as Connect4PageResult);
	const game = $derived(payload?.kind === 'ok' ? payload.game : null);

	const pieces = $derived(game?.pieces ?? []);
	const pieceIds = $derived(pieces.map((p) => p.id as string));

	// Scores and the run highlight are recomputed client-side from the pieces on show —
	// the rules module is pure and client-safe, and deriving them here means a freshly
	// polled piece lights its four-in-a-row the same instant it lands.
	const standings = $derived(game ? computeStandings(pieces, game.scoring) : []);
	const runCells = $derived(runCellSet(standings.flatMap((s) => s.runs)));

	// ── playback ──────────────────────────────────────────────────────────────
	// Whatever landed since this browser last watched the board falls into place, in claim
	// order. The baseline is the LAST VISIT (localStorage, shared with the admin tester —
	// it is the same board), so coming back to a board that moved on shows what you missed
	// instead of silently swapping it.
	const playback = new Playback();
	let speed = $state(1);
	let replaying = $state(false);

	// The board this effect last acted on, so it doesn't re-run on polls that change
	// nothing and cancel a run it just started.
	let handled = '';

	$effect(() => {
		const ids = pieceIds;
		const slug = game?.slug;
		if (!slug || replaying) return;

		const key = ids.join('|');
		if (key === handled) return;
		handled = key;

		const seen = loadSeen(slug);
		const fresh = ids.filter((id) => !seen.has(id));
		if (fresh.length && fresh.length < ids.length) {
			// The new pieces are the tail of the list; start the run where they begin. The
			// ids are banked when the run ENDS, so a run cut short by a reload replays.
			playback.play(ids, ids.length - fresh.length, paceFor(fresh.length, speed));
		} else {
			// Nothing new, or a board this browser has never seen at all — a first visit
			// shows the board as it stands rather than replaying the entire event unasked.
			playback.showAll(ids.length);
			saveSeen(slug, ids);
		}
	});

	$effect(() => {
		if (game && playback.settled(pieceIds.length) && pieceIds.length) {
			saveSeen(game.slug, pieceIds);
		}
	});

	function replayAll() {
		replaying = true;
		playback.play(pieceIds, 0, paceFor(pieceIds.length, speed));
	}
	function stopReplay() {
		replaying = false;
		playback.skip(pieceIds.length);
		if (game) saveSeen(game.slug, pieceIds);
	}
	$effect(() => {
		if (replaying && !playback.playing) {
			replaying = false;
			if (game) saveSeen(game.slug, pieceIds);
		}
	});

	let selected = $state<number | null>(null);
	const selectedTile = $derived(
		selected === null ? null : (game?.live[selected] ?? null)
	);

	// ── 2D / 3D ───────────────────────────────────────────────────────────────
	// Same key as the admin tester: it is a preference about how boards look, not a
	// per-page mode.
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

	// The 3D board raycasts its own hover and reports it here; the flat board draws its
	// own card. Same flag-not-cancel dance as everywhere: leaving the canvas for the card
	// must not clear the hover before the pointer reaches the wiki links.
	let hover3d = $state<HoverInfo | null>(null);
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
		p.drop_key?.startsWith('manual:')
			? 'credited by hand'
			: p.drop_key?.startsWith('test-')
				? 'simulated'
				: 'from a Dink drop';

	const hover3dCard = $derived.by((): CardInfo | null => {
		const h = hover3d;
		if (!h || !game) return null;
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
			anyOf: h.tile.tile.any_of?.map((m) => m.item_name) ?? null,
			qty: h.tile.tile.qty ?? null,
			progress: h.tile.progress ?? null,
			sideNames: game.sides.map((s) => s.name),
			where: `column ${columnLabel(h.tile.col)}`,
			x: h.x,
			y: h.y
		};
	});

	// ── live updates ──────────────────────────────────────────────────────────
	// Version-driven (docs/LIVE-UPDATES.md): poll the ~100-byte token and refetch the
	// board only when it moves, so an open board never shows a stale tile. Paused during
	// a replay — a refetch must not pull the board out from under a run mid-flight.
	let refreshedAt = $state<string>('');
	async function refresh() {
		await invalidateAll();
		refreshedAt = new Date().toLocaleTimeString();
	}
	liveEvent(() => game?.id ?? '', {
		onChange: refresh,
		// The payload's own token baselines the poll (a getter, because the payload lands
		// after init) — without it, a credit between render and the first poll became the
		// baseline and the board sat stale until the NEXT change.
		initial: () => (payload?.kind === 'ok' ? payload.live : undefined),
		paused: () => !game || game.phase !== 'live' || playback.playing
	});
	onMount(() => {
		refreshedAt = new Date().toLocaleTimeString();
		return () => playback.stop();
	});

	const mySide = $derived(
		game && game.viewerSide ? (game.sides[game.viewerSide - 1] ?? null) : null
	);
	const winnerSide = $derived(
		game && game.winner ? (game.sides[game.winner - 1] ?? null) : null
	);
</script>

<svelte:head><title>{game ? game.name : 'Connect Four'} — Connect Four</title></svelte:head>

<div class="page">
	{#if !res.ready}
		<Skeleton height="2rem" />
		<Skeleton height="6rem" />
		<Skeleton height="22rem" />
	{:else if payload?.kind === 'not_found' || !game}
		<section class="osrs-panel">
			<div class="osrs-titlebar">Connect Four</div>
			<div class="pad"><p class="muted">There's no game here.</p></div>
		</section>
	{:else}
		<header>
			<div>
				<a href="/events" class="back">← Events</a>
				<h1>{game.name}</h1>
			</div>
			<div class="head-right">
				<span class="osrs-badge">{game.phase}</span>
				{#if game.test}<span class="osrs-badge test">test</span>{/if}
				{#if mySide}
					<span class="pill" style="--c: {mySide.color}">You play for {mySide.name}</span>
				{/if}
				{#if refreshedAt && game.phase === 'live'}
					<span class="muted tiny">live · updated {refreshedAt}</span>
				{/if}
			</div>
		</header>

		{#if game.description}<p class="muted desc">{game.description}</p>{/if}

		{#if game.phase === 'finished'}
			<p class="ok">
				{#if winnerSide}
					Finished — <strong>{winnerSide.name}</strong> takes it.
				{:else}
					Finished — dead even.
				{/if}
			</p>
		{/if}

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
					<div class="total">{st?.total.toLocaleString() ?? 0}</div>
					<div class="muted tiny">
						{st?.tiles ?? 0} tiles ({st?.tilePoints.toLocaleString() ?? 0}) · lines
						{st?.linePoints.toLocaleString() ?? 0}
						{#if (st?.longest ?? 0) >= 4} · longest {st?.longest} in a row{/if}
					</div>
				</div>
			{/each}
		</section>

		<!-- ── the board ─────────────────────────────────────────────────────── -->
		<section class="osrs-panel board-panel">
			<div class="osrs-titlebar">
				The board — {pieces.length} / {game.deckSize} claimed
			</div>
			<div class="pad">
				{#if game.phase === 'setup'}
					<p class="muted">
						The board opens when the game starts — check back once the event is underway.
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
										? (((playback.revealed ?? 0) - playback.from) / (playback.to - playback.from)) *
											100
										: 100}%"
								></span>
							</span>
						{:else}
							<button type="button" onclick={replayAll} disabled={!pieces.length}>
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
							<span class="muted tiny">{pieces.length} claims</span>
						{/if}
						<span class="viewtoggle">
							<button type="button" class:on={view === 'flat'} onclick={() => setView('flat')}>
								Flat
							</button>
							<button type="button" class:on={view === '3d'} onclick={() => setView('3d')}>
								3D
							</button>
						</span>
					</div>

					{#key game.id}
						{#if view === '3d'}
							<Connect4Board3D
								{pieces}
								live={game.live}
								cols={game.cols}
								rows={game.rows}
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
								{pieces}
								live={game.live}
								cols={game.cols}
								rows={game.rows}
								sideColors={game.sides.map((s) => s.color)}
								sideNames={game.sides.map((s) => s.name)}
								{runCells}
								revealed={playback.revealed}
								falling={playback.falling}
								{selected}
								onselect={(c) => (selected = selected === c ? null : c)}
							/>
						{/if}
					{/key}

					{#if selectedTile}
						<div class="tile-detail">
							<WikiImage
								src={itemImageUrl(selectedTile.tile.any_of?.[0]?.item_name ?? selectedTile.tile.item_name)}
								alt=""
								size={40}
							/>
							<div>
								<strong>{columnLabel(selectedTile.col)} — {selectedTile.tile.item_name}</strong>
								<div class="muted tiny">
									{#if selectedTile.tile.source}
										<WikiImage src={monsterImageUrl(selectedTile.tile.source)} alt="" size={16} />
										{selectedTile.tile.source}
									{/if}
									{#if selectedTile.tile.ehb} · {formatEhb(selectedTile.tile.ehb)} to obtain{/if}
									{#if selectedTile.tile.qty && selectedTile.tile.qty > 1}
										· first side to {selectedTile.tile.qty} drops
										{#if selectedTile.progress}
											({game.sides[0]?.name} {selectedTile.progress[1]}/{selectedTile.tile.qty},
											{game.sides[1]?.name} {selectedTile.progress[2]}/{selectedTile.tile.qty})
										{/if}
									{/if}
								</div>
								{#if selectedTile.tile.any_of?.length}
									<div class="muted tiny">
										any of: {selectedTile.tile.any_of.map((m) => m.item_name).join(', ')}
									</div>
								{/if}
							</div>
						</div>
					{:else if game.phase === 'live'}
						<p class="muted tiny hint">
							Get the drop above a column and it's your side's piece — first come, first served.
							Click a tile to see what it takes.
						</p>
					{/if}
				{/if}
			</div>
		</section>

		<!-- ── the log ───────────────────────────────────────────────────────── -->
		{#if pieces.length}
			<section class="osrs-panel">
				<div class="osrs-titlebar">Latest claims</div>
				<div class="table-wrap">
					<table class="osrs-table">
						<thead>
							<tr><th>Cell</th><th>Side</th><th>Tile</th><th>By</th><th>How</th></tr>
						</thead>
						<tbody>
							{#each [...pieces].reverse().slice(0, 60) as p (p.id)}
								<tr>
									<td>{columnLabel(p.col)}{p.row + 1}</td>
									<td>
										<span class="pill" style="--c: {game.sides[p.side - 1]?.color}">
											{game.sides[p.side - 1]?.name ?? `side ${p.side}`}
										</span>
									</td>
									<td>{p.item_name}</td>
									<td>{p.by_rsn ?? '—'}</td>
									<td class="tiny muted">
										{#if p.drop_key?.startsWith('manual:')}by hand{:else if p.drop_key?.startsWith('test-')}simulated{:else}Dink{/if}
									</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
			</section>
		{/if}
	{/if}
</div>

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
	.desc {
		margin: -0.5rem 0 0;
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
		background:
			radial-gradient(circle at 36% 30%, rgba(255, 255, 255, 0.5) 0%, transparent 45%),
			var(--c);
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
	.pad {
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
	.pill {
		font-size: 0.7rem;
		padding: 0.05rem 0.4rem;
		border-radius: 999px;
		border: 1px solid var(--c);
		color: var(--c);
	}
	.tiny {
		font-size: 0.75rem;
	}
	label.tiny {
		display: inline-flex;
		align-items: center;
		gap: 0.3rem;
	}
	.muted {
		color: var(--muted);
	}
	.ok {
		margin: 0;
		padding: 0.5rem 0.75rem;
		border: 1px solid var(--success);
		border-radius: var(--radius);
		color: var(--success);
		background: var(--success-bg);
	}
</style>
