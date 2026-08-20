// End-to-end Connect Four simulation — drives a whole game (create → curate → assign →
// start → claims → board full) against whatever Supabase the shell points at, through the
// REAL server module. Nothing here reimplements the rules; it calls
// src/lib/server/connect4.ts so a bug in the shipped code fails the run.
//
//   npm run sim:connect4
//   npm run sim:connect4 -- --seed 7 --keep
//
// Flags:
//   --players N   members to split across the two sides (default 24)
//   --seed N      seed the RNG so a run is reproducible (default: time-based)
//   --keep        leave the event in the database instead of deleting it
//   --slug S      reuse/create a specific slug
//   --quick       skip the fill-the-whole-board stage (250 claims)
//
// Run it against STAGING. It creates a real unlisted TEST event plus its teams, signups
// and pieces, and deletes them again unless --keep. It never touches an event it did not
// create.

import { createServer } from 'vite';

// ── args ────────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
	const i = argv.indexOf(`--${name}`);
	return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
};
const has = (name) => argv.includes(`--${name}`);

const PLAYERS = Number(flag('players', 24));
const SEED = Number(flag('seed', Date.now() % 100000));
const KEEP = has('keep');
const QUICK = has('quick');
const SLUG = flag('slug', `sim-connect4-${Date.now().toString(36)}`);

let seed = SEED >>> 0 || 1;
const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);

// ── harness ─────────────────────────────────────────────────────────────────

let pass = 0;
const failures = [];
function check(label, cond, detail) {
	if (cond) {
		pass++;
		console.log(`  ✓ ${label}`);
	} else {
		failures.push(label + (detail ? ` — ${detail}` : ''));
		console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
	}
}
const step = (n, title) => console.log(`\n── ${n}. ${title} ──`);

const server = await createServer({ server: { middlewareMode: true }, logLevel: 'error', appType: 'custom' });

let exitCode = 0;
let eventId = null;
let sb = null;

try {
	const c4 = await server.ssrLoadModule('/src/lib/server/connect4.ts');
	const pool = await server.ssrLoadModule('/src/lib/server/connect4Pool.ts');
	const rules = await server.ssrLoadModule('/src/lib/connect4/rules.ts');
	const { db } = await server.ssrLoadModule('/src/lib/server/db.ts');
	sb = db();

	console.log(`Connect Four simulation — ${PLAYERS} players, seed ${SEED}, slug ${SLUG}`);

	// ── 1. roster ────────────────────────────────────────────────────────────
	step(1, 'Pick simulated players from the roster');
	const { data: users, error: uErr } = await sb
		.from('vs_users')
		.select('id, rsn')
		.not('rsn', 'is', null)
		.limit(Math.max(PLAYERS * 2, 64));
	if (uErr) throw new Error(`roster read failed: ${uErr.message}`);
	const roster = (users ?? []).filter((u) => u.rsn);
	check(`roster has at least ${PLAYERS} members`, roster.length >= PLAYERS, `found ${roster.length}`);
	if (roster.length < PLAYERS) throw new Error('not enough members on the roster to simulate');
	const players = roster.slice(0, PLAYERS);
	const half = Math.floor(PLAYERS / 2);
	const sideOne = players.slice(0, half);
	const sideTwo = players.slice(half);

	// ── 2. create ────────────────────────────────────────────────────────────
	step(2, 'Create the game');
	const created = await c4.createConnect4({
		slug: SLUG,
		name: `Simulated Connect Four`,
		description: 'Automated end-to-end simulation. Safe to delete.',
		ownerUserId: players[0].id,
		test: true
	});
	check('game created', created.ok, created.ok ? '' : created.error);
	if (!created.ok) throw new Error(created.error);
	eventId = created.value.id;

	let snap = await c4.loadConnect4(SLUG);
	check('phase starts at setup', snap.phase === 'setup', snap.phase);
	check('two sides exist with team rows', snap.sides.length === 2 && snap.sides.every((s) => s.teamId));
	check('sides are red and yellow', snap.sides[0].color === '#ef4444' && snap.sides[1].color === '#eab308');
	check('event is unlisted and not open yet', snap.status === 'draft');

	// ── 3. the tile pool ─────────────────────────────────────────────────────
	step(3, 'Generate and curate the tile pool');
	const candidates = await pool.poolCandidates();
	check('candidate pool is big enough to curate from', candidates.length >= rules.DECK_SIZE, `${candidates.length}`);
	check('candidates are sorted easiest first', candidates.every((c, i) => i === 0 || candidates[i - 1].ehb <= c.ehb));
	check('every candidate names a boss', candidates.every((c) => !!c.source));

	const tooFew = await c4.setPool(eventId, pool.toTileRefs(candidates.slice(0, 10)));
	check('a short pool is refused', !tooFew.ok, tooFew.ok ? 'accepted 10 tiles' : '');

	const picked = pool.autoSelect(candidates, rules.DECK_SIZE);
	check('auto-select returns exactly a full board', picked.length === rules.DECK_SIZE, `${picked.length}`);
	check('auto-select spans the difficulty range', picked[picked.length - 1].ehb > picked[0].ehb);

	const dupes = pool.toTileRefs([picked[0], ...picked.slice(0, rules.DECK_SIZE - 1)]);
	const dupeRes = await c4.setPool(eventId, dupes);
	check('a pool with a repeated item is refused', !dupeRes.ok, dupeRes.ok ? 'accepted duplicates' : '');

	const setRes = await c4.setPool(eventId, pool.toTileRefs(picked));
	check('the curated pool is accepted', setRes.ok, setRes.ok ? '' : setRes.error);

	// ── 4. teams ─────────────────────────────────────────────────────────────
	step(4, 'Put members on sides');
	const startTooEarly = await c4.startGame(eventId, SEED);
	check('a game with nobody on a side will not start', !startTooEarly.ok, startTooEarly.ok ? 'started' : '');

	const e1 = await c4.enrolMembers({ eventId, userIds: sideOne.map((p) => p.id), side: 1 });
	const e2 = await c4.enrolMembers({ eventId, userIds: sideTwo.map((p) => p.id), side: 2 });
	check('side 1 enrolled', e1.ok, e1.ok ? '' : e1.error);
	check('side 2 enrolled', e2.ok, e2.ok ? '' : e2.error);

	snap = await c4.loadConnect4(SLUG);
	check('side 1 has its members', snap.sides[0].members.length === sideOne.length, `${snap.sides[0].members.length}`);
	check('side 2 has its members', snap.sides[1].members.length === sideTwo.length, `${snap.sides[1].members.length}`);
	check('nobody is left unassigned', snap.unassigned.length === 0, `${snap.unassigned.length}`);
	check('sideForUser resolves a member', (await c4.sideForUser(eventId, sideTwo[0].id)) === 2);

	// Re-enrolling the same member is a no-op, not a duplicate signup.
	await c4.enrolMembers({ eventId, userIds: [sideOne[0].id], side: 1 });
	snap = await c4.loadConnect4(SLUG);
	check('re-enrolling does not duplicate a member', snap.sides[0].members.length === sideOne.length);

	// ── 5. start ─────────────────────────────────────────────────────────────
	step(5, 'Deal the deck and open the game');
	const started = await c4.startGame(eventId, SEED);
	check('the game started', started.ok, started.ok ? '' : started.error);

	snap = await c4.loadConnect4(SLUG);
	check('phase is live', snap.phase === 'live', snap.phase);
	check('the event is open so tiles can be tracked', snap.status === 'open', snap.status);
	check('starts_at is stamped', !!snap.startsAt);
	check('the deck is a full board', snap.deck.length === rules.DECK_SIZE, `${snap.deck.length}`);
	check(
		'the deck is a permutation of the pool',
		new Set(snap.deck.map((t) => t.item_id)).size === rules.DECK_SIZE &&
			snap.deck.every((t) => picked.some((p) => p.item_id === t.item_id))
	);
	check('25 tiles are live, one per column', snap.live.filter(Boolean).length === rules.COLS);
	check(
		'each column opens on its own deck slice',
		snap.live.every((l, i) => l.deckIdx === i * rules.ROWS)
	);

	const restart = await c4.startGame(eventId, SEED + 1);
	check('a second start is refused (CAS holds)', !restart.ok, restart.ok ? 'dealt twice' : '');
	const afterRestart = await c4.loadConnect4(SLUG);
	check('the deal did not change', afterRestart.deck[0].item_id === snap.deck[0].item_id);

	// The deal is reproducible from the stored seed.
	const replay = rules.shuffleDeck(snap.pool, rules.seededRandom(snap.seed));
	check('the stored seed reproduces the deal', replay.every((t, i) => t.item_id === snap.deck[i].item_id));

	// ── 6. the tracked-item projection ───────────────────────────────────────
	step(6, 'The live tiles reach the Dink allowlist');
	const trackedOf = async () => {
		const { data } = await sb
			.from('vs_event_tracked_items')
			.select('tile_id, item_id, item_name, match_type')
			.eq('event_id', eventId);
		return data ?? [];
	};
	let tracked = await trackedOf();
	check('25 tracked items, one per column', tracked.length === rules.COLS, `${tracked.length}`);
	check(
		'every tracked item is the live tile of its column',
		tracked.every((t) => {
			const col = Number(t.tile_id.split(':')[1]);
			return snap.live[col].tile.item_id === t.item_id;
		})
	);
	check('tracked items match on loot', tracked.every((t) => t.match_type === 'loot'));

	// The proxy allowlist is fed from a view over these rows — check the member actually
	// sees them, since that join (signups × open event × starts_at) is what makes tracking
	// work at all.
	const { data: activeRows } = await sb
		.from('vs_active_player_tiles')
		.select('tile_id, item_id, type')
		.eq('event_id', eventId)
		.eq('user_id', sideOne[0].id);
	check('a member sees all 25 tiles as active', (activeRows ?? []).filter((r) => r.type === 'item').length === rules.COLS,
		`${(activeRows ?? []).length}`);

	// ── 7. claims ────────────────────────────────────────────────────────────
	step(7, 'Claim tiles');
	const liveAt = (s, col) => s.live[col].tile;

	const target = liveAt(snap, 0);
	const first = await c4.claimTile({
		eventId,
		side: 1,
		dropKey: `test-first-${SEED}`,
		itemId: target.item_id,
		itemName: target.item_name,
		byUserId: sideOne[0].id
	});
	check('a matching drop claims its tile', first.status === 'claimed', `${first.status} ${first.error ?? ''}`);
	check('the piece lands on the bottom row', first.row === 0 && first.col === 0, `${first.col},${first.row}`);
	check('the claim reports the tile it completed', first.tile.item_id === target.item_id);
	check('a replacement tile is dealt in', !!first.replacement && first.replacement.item_id !== target.item_id);

	snap = await c4.loadConnect4(SLUG);
	check('the column advanced to the next deck slot', snap.live[0].deckIdx === 1);
	check('the replacement is what the board now shows', snap.live[0].tile.item_id === first.replacement.item_id);
	check('other columns did not move', snap.live[1].deckIdx === rules.ROWS);

	tracked = await trackedOf();
	const col0 = tracked.find((t) => t.tile_id === 'col:0');
	check('the claimed tile left the allowlist', col0.item_id === first.replacement.item_id);
	check('the allowlist is still 25 long', tracked.length === rules.COLS);

	// Idempotency — the reconcile pass re-runs recent drops on purpose.
	const again = await c4.claimTile({
		eventId,
		side: 1,
		dropKey: `test-first-${SEED}`,
		itemId: target.item_id,
		itemName: target.item_name
	});
	check('the same drop claims nothing twice', again.status === 'duplicate', again.status);

	// A drop for an item that isn't on the board.
	const nothing = await c4.claimTile({
		eventId,
		side: 2,
		dropKey: `test-nomatch-${SEED}`,
		itemId: -1,
		itemName: 'Not a real item'
	});
	check('an unlisted item claims nothing', nothing.status === 'no_tile', nothing.status);

	// A drop that predates the game.
	const early = await c4.claimTile({
		eventId,
		side: 2,
		dropKey: `test-early-${SEED}`,
		itemId: snap.live[1].tile.item_id,
		itemName: snap.live[1].tile.item_name,
		receivedAt: new Date(Date.parse(snap.startsAt) - 60_000).toISOString()
	});
	check('a drop from before the game claims nothing', early.status === 'timing', early.status);

	// A test game must not swallow real Dink traffic.
	const realish = await c4.claimTile({
		eventId,
		side: 2,
		dropKey: 'a3f9c1e2b7d4', // a real drop_key is a hash, with no test-/manual: prefix
		itemId: snap.live[1].tile.item_id,
		itemName: snap.live[1].tile.item_name
	});
	check('a test game refuses a real drop key', realish.status === 'blocked', realish.status);

	// ── 7b. the race ─────────────────────────────────────────────────────────
	step('7b', 'Two teams race for the same shared tile');
	snap = await c4.loadConnect4(SLUG);
	const contested = liveAt(snap, 5);
	const [raceA, raceB] = await Promise.all([
		c4.claimTile({
			eventId, side: 1, dropKey: `test-race-a-${SEED}`,
			itemId: contested.item_id, itemName: contested.item_name, byUserId: sideOne[0].id
		}),
		c4.claimTile({
			eventId, side: 2, dropKey: `test-race-b-${SEED}`,
			itemId: contested.item_id, itemName: contested.item_name, byUserId: sideTwo[0].id
		})
	]);
	// Exactly one side may claim it. The loser reports `raced` if it lost at INSERT time
	// (its row hit the unique index) or `no_tile` if it lost at READ time (the winner's
	// piece was already visible, so the column had moved on before it looked). Both are
	// correct losses — which one you get depends on how the two overlap, so asserting a
	// specific one would make this test flaky rather than strict.
	const outcomes = [raceA.status, raceB.status].sort().join('+');
	check(
		'exactly one side wins the contested tile',
		outcomes === 'claimed+raced' || outcomes === 'claimed+no_tile',
		outcomes
	);

	const { data: contestedCells } = await sb
		.from('vs_connect4_pieces')
		.select('id')
		.eq('event_id', eventId)
		.eq('col', 5)
		.eq('row', 0);
	check('the contested cell holds exactly one piece', (contestedCells ?? []).length === 1, `${(contestedCells ?? []).length}`);

	// The same drop submitted twice at once must still only land once.
	snap = await c4.loadConnect4(SLUG);
	const twice = liveAt(snap, 6);
	const [dupA, dupB] = await Promise.all([
		c4.claimTile({ eventId, side: 1, dropKey: `test-dup-${SEED}`, itemId: twice.item_id, itemName: twice.item_name }),
		c4.claimTile({ eventId, side: 1, dropKey: `test-dup-${SEED}`, itemId: twice.item_id, itemName: twice.item_name })
	]);
	const dupOutcomes = [dupA.status, dupB.status].sort().join('+');
	check('a double-submitted drop lands once', dupOutcomes === 'claimed+duplicate', dupOutcomes);

	// ── 7c. gravity ──────────────────────────────────────────────────────────
	step('7c', 'Gravity');
	for (let i = 0; i < 3; i++) {
		snap = await c4.loadConnect4(SLUG);
		const t = liveAt(snap, 7);
		const res = await c4.claimTile({
			eventId, side: (i % 2 ? 2 : 1), dropKey: `test-grav-${i}-${SEED}`,
			itemId: t.item_id, itemName: t.item_name
		});
		check(`piece ${i + 1} of column 7 lands on row ${i}`, res.status === 'claimed' && res.row === i, `${res.status} row=${res.row}`);
	}

	// ── 7d. the real Dink pipeline ───────────────────────────────────────────
	step('7d', 'A real drop, through the whole consumer');
	const dink = await server.ssrLoadModule('/src/lib/server/dinkDrops.ts');
	snap = await c4.loadConnect4(SLUG);
	const dinkTile = liveAt(snap, 9);
	const dropper = sideTwo[0];

	const sim = await dink.simulateDinkDrop({
		event_id: eventId,
		rsn: dropper.rsn,
		item_id: dinkTile.item_id,
		item_name: dinkTile.item_name,
		source: dinkTile.source,
		received_at: new Date().toISOString()
	});
	check('the drop was processed', sim.ok && sim.processed >= 1, JSON.stringify(sim));
	snap = await c4.loadConnect4(SLUG);
	const dinkPiece = snap.pieces.find((p) => p.col === 9 && p.row === 0);
	check('a real Dink drop claims the tile above its column', !!dinkPiece);
	check('it lands for the DROPPER\'S side', dinkPiece?.side === 2, `side=${dinkPiece?.side}`);
	check('and is attributed to the dropper', dinkPiece?.by_user_id === dropper.id);

	const { data: dropRows } = await sb
		.from('vs_dink_drops')
		.select('id, outcome, drop_key, processed')
		.eq('rsn', dropper.rsn)
		.eq('item_id', dinkTile.item_id)
		.order('received_at', { ascending: false })
		.limit(1);
	const dropRow = (dropRows ?? [])[0];
	check('the drop is stamped credited', dropRow?.outcome === 'credited', dropRow?.outcome);

	// The reconcile pass deliberately re-runs recent drops — it must not drop a second piece.
	await sb.from('vs_dink_drops').update({ processed: false, outcome: null }).eq('id', dropRow.id);
	await dink.processDinkDrops({ reconcile: true, suppressFeed: true });
	snap = await c4.loadConnect4(SLUG);
	check('re-running the drop claims nothing further', snap.pieces.filter((p) => p.col === 9).length === 1);
	const { data: reRow } = await sb.from('vs_dink_drops').select('outcome').eq('id', dropRow.id).maybeSingle();
	check('and it is stamped duplicate, not "didn\'t credit"', reRow?.outcome === 'duplicate', reRow?.outcome);

	// A collection-log unlock sends a SECOND notification for the same drop, seconds later
	// and with a different drop_key. It must not claim a second cell.
	snap = await c4.loadConnect4(SLUG);
	const clogTile = liveAt(snap, 9);
	await dink.simulateDinkDrop({
		event_id: eventId,
		rsn: dropper.rsn,
		item_id: dinkTile.item_id,
		item_name: dinkTile.item_name,
		source: 'Collection log',
		received_at: new Date().toISOString(),
		notif_type: 'collection'
	});
	snap = await c4.loadConnect4(SLUG);
	check(
		'the collection-log twin of a claimed drop claims nothing',
		snap.pieces.filter((p) => p.col === 9).length === 1,
		`${snap.pieces.filter((p) => p.col === 9).length} pieces in column 9`
	);
	check('the column did not advance twice', snap.live[9].tile.item_id === clogTile.item_id);

	// Someone signed up but not yet put on a side must never be guessed at.
	const bench = roster.find((u) => !players.some((p) => p.id === u.id));
	if (bench) {
		await sb.from('vs_event_signups').insert({ event_id: eventId, user_id: bench.id });
		snap = await c4.loadConnect4(SLUG);
		const benchTile = liveAt(snap, 11);
		await dink.simulateDinkDrop({
			event_id: eventId,
			rsn: bench.rsn,
			item_id: benchTile.item_id,
			item_name: benchTile.item_name,
			source: benchTile.source,
			received_at: new Date().toISOString()
		});
		snap = await c4.loadConnect4(SLUG);
		check('a member with no side claims nothing', !snap.pieces.some((p) => p.col === 11));
		await sb.from('vs_event_signups').delete().eq('event_id', eventId).eq('user_id', bench.id);
	}

	// ── 8. scoring ───────────────────────────────────────────────────────────
	step(8, 'Scoring, and what extending a line pays');
	// Build a run for side 1 along the bottom of columns 10..14 by crediting manually.
	const scoreOf = (s, side) => s.standings.find((x) => x.side === side);
	for (let col = 10; col <= 13; col++) {
		const res = await c4.creditManual({ eventId, side: 1, col });
		check(`manual credit fills column ${col}`, res.status === 'claimed', res.status);
	}
	snap = await c4.loadConnect4(SLUG);
	const afterFour = scoreOf(snap, 1);
	check('a connect four is detected', afterFour.longest === 4, `longest=${afterFour.longest}`);
	check('the run scores the 4-tier once', afterFour.linePoints === 100, `${afterFour.linePoints}`);
	const fourTotal = afterFour.total;

	const extend = await c4.creditManual({ eventId, side: 1, col: 14 });
	check('extending the line is reported as a run', extend.status === 'claimed' && extend.newRuns.some((r) => r.len === 5),
		JSON.stringify(extend.newRuns?.map((r) => r.len)));
	snap = await c4.loadConnect4(SLUG);
	const afterFive = scoreOf(snap, 1);
	check('the five-run replaces the four-run rather than stacking', afterFive.linePoints === 250, `${afterFive.linePoints}`);
	check(
		'extending pays the upgrade delta plus the tile',
		afterFive.total - fourTotal === 150 + snap.scoring.tile_points,
		`${afterFive.total - fourTotal}`
	);

	// Retuning mid-game re-scores the whole board — no migration, no drift.
	await c4.updateScoring(eventId, { ...snap.scoring, line_points: [{ len: 4, points: 1 }, { len: 5, points: 2 }] });
	snap = await c4.loadConnect4(SLUG);
	check('retuned scoring applies to lines already on the board', scoreOf(snap, 1).linePoints === 2, `${scoreOf(snap, 1).linePoints}`);
	await c4.updateScoring(eventId, rules.DEFAULT_SCORING);

	// ── 9. undo ──────────────────────────────────────────────────────────────
	step(9, 'Undo');
	snap = await c4.loadConnect4(SLUG);
	const bottomOfSeven = snap.pieces.find((p) => p.col === 7 && p.row === 0);
	const badUndo = await c4.undoClaim({ eventId, pieceId: bottomOfSeven.id });
	check('a piece under others cannot be removed', !badUndo.ok, badUndo.ok ? 'removed' : '');

	const topOfSeven = snap.pieces.find((p) => p.col === 7 && p.row === 2);
	const beforeUndo = await c4.loadConnect4(SLUG);
	const goodUndo = await c4.undoClaim({ eventId, pieceId: topOfSeven.id });
	check('the top piece of a column can be removed', goodUndo.ok, goodUndo.ok ? '' : goodUndo.error);
	snap = await c4.loadConnect4(SLUG);
	check('the board shrank by one', snap.pieces.length === beforeUndo.pieces.length - 1);
	check('the column went back to the tile it was on', snap.live[7].deckIdx === 7 * rules.ROWS + 2);
	tracked = await trackedOf();
	check(
		'the allowlist followed the undo',
		tracked.find((t) => t.tile_id === 'col:7').item_id === snap.live[7].tile.item_id
	);

	// Undoing the five-run drops the score back to the four-run's value.
	const fiveEnd = snap.pieces.find((p) => p.col === 14 && p.row === 0);
	await c4.undoClaim({ eventId, pieceId: fiveEnd.id });
	snap = await c4.loadConnect4(SLUG);
	check('undoing an extension restores the shorter line', scoreOf(snap, 1).linePoints === 100, `${scoreOf(snap, 1).linePoints}`);

	// ── 10. a column retires ─────────────────────────────────────────────────
	step(10, 'A column fills up and retires');
	for (let i = 0; i < rules.ROWS; i++) {
		snap = await c4.loadConnect4(SLUG);
		if (!snap.live[20]) break;
		await c4.creditManual({ eventId, side: i % 2 ? 2 : 1, col: 20 });
	}
	snap = await c4.loadConnect4(SLUG);
	check('the column holds a full stack', snap.pieces.filter((p) => p.col === 20).length === rules.ROWS);
	check('a full column offers no tile', snap.live[20] === null);
	tracked = await trackedOf();
	check('a retired column leaves the allowlist', !tracked.some((t) => t.tile_id === 'col:20'), `${tracked.length} tracked`);
	const fullCol = await c4.creditManual({ eventId, side: 1, col: 20 });
	check('a full column refuses another piece', fullCol.status === 'no_tile', fullCol.status);

	// ── 11. filling the board ────────────────────────────────────────────────
	if (!QUICK) {
		step(11, 'Fill the board and finish the game');
		let guard = 0;
		for (;;) {
			snap = await c4.loadConnect4(SLUG);
			const open = snap.live.filter(Boolean);
			if (!open.length) break;
			if (guard++ > rules.DECK_SIZE + 20) throw new Error('board did not fill');
			const t = open[Math.floor(rand() * open.length)];
			await c4.creditManual({ eventId, side: rand() < 0.5 ? 1 : 2, col: t.col });
		}
		snap = await c4.loadConnect4(SLUG);
		check('every cell is claimed', snap.pieces.length === rules.DECK_SIZE, `${snap.pieces.length}`);
		check('the game finished on its own', snap.phase === 'finished', snap.phase);
		const [s1, s2] = snap.standings;
		const expected = s1.total === s2.total ? null : s1.total > s2.total ? 1 : 2;
		check('the winner is whoever scored most', snap.winner === expected, `winner=${snap.winner} ${s1.total}v${s2.total}`);
		check('tiles claimed add up to the board', s1.tiles + s2.tiles === rules.DECK_SIZE);
		tracked = await trackedOf();
		check('a finished game tracks nothing', tracked.length === 0, `${tracked.length} left`);

		// ── 12. reopening ────────────────────────────────────────────────────
		step(12, 'Reopening a finished game');
		const last = snap.pieces.reduce((a, b) => (Date.parse(a.claimed_at) > Date.parse(b.claimed_at) ? a : b));
		const topOfLast = snap.pieces.filter((p) => p.col === last.col).reduce((a, b) => (a.row > b.row ? a : b));
		const reopened = await c4.undoClaim({ eventId, pieceId: topOfLast.id });
		check('undoing from a finished board works', reopened.ok, reopened.ok ? '' : reopened.error);
		snap = await c4.loadConnect4(SLUG);
		check('the game reopened', snap.phase === 'live', snap.phase);
		check('and it tracks again', (await trackedOf()).length === 1, `${(await trackedOf()).length}`);
	}

	// ── 13. redaction ────────────────────────────────────────────────────────
	step(13, 'What a member may see');
	snap = await c4.loadConnect4(SLUG);
	const asMember = c4.redactSnapshot(snap, false);
	check('a member gets no undealt deck', asMember.deck.length === 0);
	check('a member gets no pool', asMember.pool.length === 0);
	check('a member still gets the board', asMember.pieces.length === snap.pieces.length);
	check('a member still gets the live tiles', asMember.live.filter(Boolean).length === snap.live.filter(Boolean).length);
	const serialized = JSON.stringify(asMember);
	const undealt = snap.deck.filter((t, i) => !snap.live.some((l) => l && l.deckIdx === i) && !snap.pieces.some((p) => p.deck_idx === i));
	check(
		'no undealt tile name leaks in the member payload',
		undealt.slice(0, 40).every((t) => !serialized.includes(t.item_name)),
		`checked ${Math.min(40, undealt.length)} undealt tiles`
	);
} catch (err) {
	console.error(`\n✗ simulation aborted: ${err.message}`);
	exitCode = 1;
} finally {
	if (eventId && !KEEP && sb) {
		try {
			const c4 = await server.ssrLoadModule('/src/lib/server/connect4.ts');
			const removed = await c4.deleteConnect4(eventId);
			console.log(removed.ok ? '\nCleaned up the simulated game.' : `\nCleanup failed: ${removed.error}`);
		} catch (err) {
			console.error(`cleanup failed: ${err.message}`);
		}
	} else if (KEEP) {
		console.log(`\nLeft the game behind: /admin/connect4/${SLUG}`);
	}
	await server.close();
}

console.log(`\n${pass} checks passed, ${failures.length} failed`);
if (failures.length) {
	for (const f of failures) console.log(`  ✗ ${f}`);
	exitCode = 1;
}
process.exit(exitCode);
