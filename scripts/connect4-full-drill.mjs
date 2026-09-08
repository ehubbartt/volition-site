// Full Connect Four staging drill — every notable path in one run, through the REAL
// server modules and the REAL Dink consumer (vs_dink_drops → processDinkDrops):
//
//   • mixed roster: Volition members vs visiting-clan users (allegiance-tested)
//   • Dink drops from both camps          • manual/admin submissions (explicit column)
//   • raid group tile ("any raids purple") • quantity tile (first side to 3 drops)
//   • copies (same item in two deck slots) • race → terminal `raced`
//   • duplicate / unknown-rsn / pre-game timing / real-key-on-test-game guards
//   • undo, then the tile claims again     • delete cleans drops + progress
//
//   node scripts/connect4-full-drill.mjs        (against whatever Supabase the shell points at)
//
// Creates one unlisted TEST game and deletes it (and all its rows) at the end.

import { createServer } from 'vite';

const SLUG = `drill-full-${Date.now().toString(36)}`;
const COLS = 6;
const ROWS = 4;
const DECK = COLS * ROWS;
const SEED = 12345;

let pass = 0;
const failures = [];
const notes = [];
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
	const dink = await server.ssrLoadModule('/src/lib/server/dinkDrops.ts');
	const clan = await server.ssrLoadModule('/src/lib/server/clan.ts');
	const { db } = await server.ssrLoadModule('/src/lib/server/db.ts');
	sb = db();

	console.log(`Connect Four FULL drill — ${COLS}×${ROWS}, slug ${SLUG}`);

	// ── 1. mixed roster ──────────────────────────────────────────────────────
	step(1, 'Roster: Volition members vs visiting-clan users');
	const { data: users } = await sb
		.from('vs_users')
		.select('id, discord_id, rsn')
		.not('rsn', 'is', null)
		.limit(80);
	const withRsn = (users ?? []).filter((u) => u.rsn);
	const memberIds = await clan.clanMemberIds(withRsn);
	const volition = withRsn.filter((u) => memberIds.has(u.id)).slice(0, 4);
	const visitors = withRsn.filter((u) => !memberIds.has(u.id)).slice(0, 3);
	check('at least 3 Volition members found', volition.length >= 3, `${volition.length}`);
	check('at least 2 visiting-clan users found', visitors.length >= 2, `${visitors.length}`);
	if (volition.length < 3 || visitors.length < 2) throw new Error('roster too thin to drill');
	notes.push(`Roster: ${volition.length} Volition (side 1) vs ${visitors.length} visitors (side 2).`);

	// ── 2. create + curate ───────────────────────────────────────────────────
	step(2, `Create a ${COLS}×${ROWS} test game and curate a deck of every tile shape`);
	const created = await c4.createConnect4({
		slug: SLUG,
		name: 'Full drill',
		ownerUserId: volition[0].id,
		cols: COLS,
		rows: ROWS,
		test: true
	});
	check('game created', created.ok, created.ok ? '' : created.error);
	if (!created.ok) throw new Error(created.error);
	eventId = created.value.id;

	const candidates = await pool.poolCandidates(pool.ALL_POOL_OPTIONS);
	const raidItems = candidates.filter((c) => ['cox', 'toa', 'tobn', 'tobh'].includes(c.mechanic));
	check('raid purples exist in the universe', raidItems.length >= 20, `${raidItems.length}`);

	const grp = await c4.addCustomTile(eventId, {
		item_name: 'Any raids purple (drill)',
		source: 'CoX / ToB / ToA',
		ehb: 30,
		any_of: raidItems.slice(0, 45).map((r) => ({ item_id: r.item_id, item_name: r.item_name }))
	});
	check('group tile added', grp.ok, grp.ok ? '' : grp.error);
	const man = await c4.addCustomTile(eventId, {
		item_name: 'Drill manual-only task',
		source: 'Staff decides',
		ehb: 1
	});
	check('custom manual task added', man.ok, man.ok ? '' : man.error);

	// Normal candidates that are NOT raid items (so a raid drop can only hit the group).
	const normals = candidates.filter((c) => c.mechanic === 'kill');
	const qtyTile = { ...normals[0], qty: 3 };
	const copyTile = normals[1];

	// The deal is a seeded shuffle, so PLACE the special tiles instead of digging for
	// them: compute the permutation the game will use and arrange the pool so that
	//   col 0 opens on the group tile        col 1 opens on the ×3 quantity tile
	//   col 2 opens on copy 1, with one normal tile between it and copy 2 (so a spare
	//     drop parks as no_tile while copy 2 is buried, then credits once it surfaces)
	//   col 3 opens on the manual-only custom task
	const idxDeck = rules.shuffleDeck(
		Array.from({ length: DECK }, (_, i) => i),
		rules.seededRandom(SEED)
	);
	const arranged = new Array(DECK).fill(null);
	arranged[idxDeck[0]] = grp.value.tile;
	arranged[idxDeck[1 * ROWS]] = qtyTile;
	arranged[idxDeck[2 * ROWS]] = copyTile;
	arranged[idxDeck[2 * ROWS + 2]] = copyTile; // copy 2, one slot buried
	arranged[idxDeck[3 * ROWS]] = man.value.tile;
	let f = 2;
	for (let i = 0; i < DECK; i++) if (!arranged[i]) arranged[i] = normals[f++];
	const tiles = pool.toTileRefs(arranged);
	check('deck composition is exactly the board', tiles.length === DECK, `${tiles.length}`);
	const setRes = await c4.setPool(eventId, tiles);
	check('pool with group + qty + copies accepted', setRes.ok, setRes.ok ? '' : setRes.error);
	notes.push(
		`Deck: group "any raids purple" (${grp.ok ? 45 : 0} items), 1 manual-only custom, ` +
			`1 quantity tile ×3 (${qtyTile.item_name}), ${copyTile.item_name} ⧉2, rest normal.`
	);

	// ── 3. seat + start ──────────────────────────────────────────────────────
	step(3, 'Seat the camps and deal');
	await c4.enrolMembers({ eventId, userIds: volition.map((u) => u.id), side: 1 });
	await c4.enrolMembers({ eventId, userIds: visitors.map((u) => u.id), side: 2 });
	const started = await c4.startGame(eventId, SEED);
	check('game started', started.ok, started.ok ? '' : started.error);
	let snap = await c4.loadConnect4(SLUG);
	check('phase live, full deck', snap.phase === 'live' && snap.deck.length === DECK);
	check('col 0 opens on the group tile', snap.live[0]?.tile.item_name === grp.value.tile.item_name, snap.live[0]?.tile.item_name);
	check('col 1 opens on the quantity tile', snap.live[1]?.tile.item_name === qtyTile.item_name, snap.live[1]?.tile.item_name);
	check('col 2 opens on copy 1', snap.live[2]?.tile.item_name === copyTile.item_name, snap.live[2]?.tile.item_name);
	check('col 3 opens on the manual-only task', snap.live[3]?.tile.item_name === man.value.tile.item_name, snap.live[3]?.tile.item_name);

	// ── helpers ──────────────────────────────────────────────────────────────
	const reload = async () => (snap = await c4.loadConnect4(SLUG));
	/** The freshest dink-drop row for an rsn+item, to read the consumer's verdict. */
	async function lastDrop(rsn, itemName) {
		const { data } = await sb
			.from('vs_dink_drops')
			.select('id, outcome, tile_id, processed')
			.eq('event_id', eventId)
			.eq('rsn', rsn)
			.eq('item_name', itemName)
			.order('id', { ascending: false })
			.limit(1);
		return data?.[0] ?? null;
	}
	const now = () => new Date().toISOString();
	async function dinkDrop(rsn, item, source) {
		const r = await dink.simulateDinkDrop({
			event_id: eventId,
			rsn,
			item_id: item.item_id > 0 ? item.item_id : null,
			item_name: item.item_name,
			source: source ?? item.source ?? null,
			received_at: now()
		});
		if (!r.ok) throw new Error(`simulateDinkDrop failed: ${r.error}`);
		return lastDrop(rsn, item.item_name);
	}
	const pieceCount = async () => (await reload()).pieces.length;

	// ── 4. Dink drops from both camps ────────────────────────────────────────
	step(4, 'Dink: a Volition member and a visitor each land a live tile');
	await reload();
	// A live tile that is none of the planned specials — cols 4 and 5 open on these.
	const liveNormal = () =>
		snap.live.find(
			(l) => l && l.tile.item_id > 0 && !l.tile.qty && l.tile.item_name !== copyTile.item_name
		).tile;
	const tA = liveNormal();
	const before4 = await pieceCount();
	const dropA = await dinkDrop(volition[0].rsn, tA);
	check('Volition Dink drop credited', dropA?.outcome === 'credited', dropA?.outcome);
	await reload();
	const tB = liveNormal();
	check('a fresh tile replaced the claimed one', tB.item_name !== tA.item_name);
	const dropB = await dinkDrop(visitors[0].rsn, tB);
	check('VISITOR Dink drop credited', dropB?.outcome === 'credited', dropB?.outcome);
	check('both pieces landed', (await pieceCount()) === before4 + 2, `${await pieceCount()}`);
	notes.push(`Dink credits: Volition "${tA.item_name}", visitor "${tB.item_name}".`);

	// ── 5. manual submission ─────────────────────────────────────────────────
	step(5, 'Manual submission (explicit column, admin path)');
	await reload();
	const openCol = snap.live.indexOf(
		snap.live.find(
			(l) => l && l.tile.item_id > 0 && !l.tile.qty && l.tile.item_name !== copyTile.item_name
		)
	);
	const manual = await c4.claimTile({
		eventId, side: 2, col: openCol,
		dropKey: `manual:drill-admin-${Date.now()}`,
		byUserId: visitors[1].id
	});
	check('manual credit claims the live tile', manual.status === 'claimed', `${manual.status} ${manual.error ?? ''}`);

	// ── 6. raid group tile ───────────────────────────────────────────────────
	step(6, 'Raid tracking: a purple credits the "any raids purple" group tile');
	const purple = raidItems[3];
	const dropG = await dinkDrop(visitors[0].rsn, purple, purple.source);
	check('raid purple credited the group tile', dropG?.outcome === 'credited', dropG?.outcome);
	await reload();
	const grpPiece = snap.pieces.find((p) => p.col === 0 && p.drop_key.startsWith('test-'));
	check('the group piece landed in col 0', !!grpPiece);
	notes.push(`Raid group: "${purple.item_name}" (${purple.source}) claimed the any-purple tile.`);

	// ── 7. quantity tile ─────────────────────────────────────────────────────
	step(7, `Quantity ×3: two side-1 drops bank progress, a side-2 drop counts apart, the 3rd claims`);
	const q1 = await dinkDrop(volition[0].rsn, qtyTile);
	const q2 = await dinkDrop(volition[1].rsn, qtyTile);
	check('side-1 drop 1 is partial', q1?.outcome === 'partial', q1?.outcome);
	check('side-1 drop 2 is partial', q2?.outcome === 'partial', q2?.outcome);
	const qv = await dinkDrop(visitors[0].rsn, qtyTile);
	check("side-2's own first drop is partial too", qv?.outcome === 'partial', qv?.outcome);
	const beforeQ = await pieceCount();
	const q3 = await dinkDrop(volition[2].rsn, qtyTile);
	check('side-1 drop 3 claims the tile', q3?.outcome === 'credited', q3?.outcome);
	check('exactly one piece landed for the qty tile', (await pieceCount()) === beforeQ + 1);
	const { data: prog } = await sb
		.from('vs_connect4_progress')
		.select('side')
		.eq('event_id', eventId);
	check('progress rows banked for both sides (3 + 1)', (prog ?? []).length === 4, `${(prog ?? []).length}`);
	notes.push(`Quantity ×3 "${qtyTile.item_name}": partial, partial, (side 2 partial), credit on the 3rd side-1 drop.`);

	// ── 8. copies ────────────────────────────────────────────────────────────
	step(8, 'Copies ⧉2: one live copy credits; a spare drop waits as no_tile, then credits after reprocess');
	const c1 = await dinkDrop(volition[0].rsn, copyTile);
	check('first copy credited (col 2)', c1?.outcome === 'credited', c1?.outcome);
	// Copy 2 sits one slot deeper in col 2 → the next drop must NOT be terminal
	// (`raced`), it parks and stays reprocessable.
	const c2 = await dinkDrop(volition[3].rsn, copyTile);
	check('drop while copy 2 is buried parks as no_tile', c2?.outcome === 'no_tile', c2?.outcome);
	// Claim the one normal tile between the copies, surfacing copy 2 …
	const dig = await c4.claimTile({
		eventId, side: 1, col: 2, dropKey: `manual:drill-dig-${Date.now()}`, byUserId: volition[1].id
	});
	check('the in-between tile claims manually', dig.status === 'claimed', dig.status);
	// … then the parked drop credits on reprocess (what the reconcile pass does).
	const re = await dink.reprocessDinkDrop(c2.id);
	check('reprocess after surfacing credits it', re.credited === 1, JSON.stringify(re));
	const c2after = await lastDrop(volition[3].rsn, copyTile.item_name);
	check('parked drop is now credited', c2after?.outcome === 'credited', c2after?.outcome);
	notes.push(`Copies "${copyTile.item_name}" ⧉2: copy 1 instant; spare drop parked no_tile, credited on reprocess once copy 2 surfaced.`);

	// ── 9. the race → terminal raced ─────────────────────────────────────────
	step(9, 'Race: the loser of a claimed tile gets the terminal `raced`, not churn');
	await reload();
	const raceTile = liveNormal();
	const w = await dinkDrop(visitors[0].rsn, raceTile);
	check('winner credited', w?.outcome === 'credited', w?.outcome);
	const l = await dinkDrop(volition[0].rsn, raceTile);
	check('loser marked raced (terminal)', l?.outcome === 'raced', l?.outcome);

	// ── 10. guards ───────────────────────────────────────────────────────────
	step(10, 'Guards: unknown RSN, pre-game drop, real key on a test game, duplicate');
	const ghost = await dinkDrop('Drill Ghost RSN', { item_id: null, item_name: 'Drill manual-only task' });
	check('unknown RSN parks as no_user', ghost?.outcome === 'no_user', ghost?.outcome);
	await reload();
	const early = await c4.claimTile({
		eventId, side: 1, dropKey: `test-early-${Date.now()}`,
		itemName: snap.live.find((x) => x)?.tile.item_name,
		receivedAt: new Date(Date.parse(snap.startsAt) - 60_000).toISOString()
	});
	check('a drop from before the game is refused (timing)', early.status === 'timing', early.status);
	const realish = await c4.claimTile({
		eventId, side: 1, dropKey: 'deadbeefcafe1234',
		itemName: snap.live.find((x) => x)?.tile.item_name
	});
	check('a REAL drop key is blocked on a test game', realish.status === 'blocked', realish.status);
	// Duplicate is proven the honest way: replay an existing drop_key.
	const { data: anyPiece } = await sb
		.from('vs_connect4_pieces').select('drop_key').eq('event_id', eventId).limit(1);
	const replay = await c4.claimTile({
		eventId, side: 1, dropKey: anyPiece[0].drop_key, itemName: 'whatever'
	});
	check('replaying an existing drop_key reports duplicate', replay.status === 'duplicate', replay.status);

	// ── 11. undo, then claim again ───────────────────────────────────────────
	step(11, 'Undo takes the piece off; the tile immediately claims again');
	await reload();
	const colsWithPieces = new Map();
	for (const p of snap.pieces) colsWithPieces.set(p.col, Math.max(colsWithPieces.get(p.col) ?? -1, p.row));
	const [uCol, uRow] = [...colsWithPieces.entries()][0];
	const top = snap.pieces.find((p) => p.col === uCol && p.row === uRow);
	const undone = await c4.undoClaim({ eventId, pieceId: top.id });
	check('undo removed the top piece', undone.ok, undone.ok ? '' : undone.error);
	await reload();
	const reclaim = await c4.claimTile({
		eventId, side: 2, col: uCol, dropKey: `manual:drill-reclaim-${Date.now()}`, byUserId: visitors[0].id
	});
	check('the reopened tile claims again', reclaim.status === 'claimed', `${reclaim.status} ${reclaim.error ?? ''}`);

	// ── 12. board integrity ──────────────────────────────────────────────────
	step(12, 'Board integrity after all of that');
	await reload();
	const cells = new Set(snap.pieces.map((p) => `${p.col},${p.row}`));
	check('no two pieces share a cell', cells.size === snap.pieces.length);
	const byCol = new Map();
	for (const p of snap.pieces) byCol.set(p.col, (byCol.get(p.col) ?? []).concat(p.row));
	check(
		'every column is gravity-packed from row 0',
		[...byCol.values()].every((rows) => rows.sort((a, b) => a - b).every((r, i) => r === i))
	);
	const claimedIdx = new Set(snap.pieces.map((p) => p.deck_idx));
	check('every piece consumed a distinct deck slot', claimedIdx.size === snap.pieces.length);
	notes.push(`Finished with ${snap.pieces.length}/${DECK} cells claimed; board consistent.`);

	// ── 13. delete cleans everything ─────────────────────────────────────────
	step(13, 'Delete the game — drops, progress, tracked items and pieces all go');
	const del = await c4.deleteConnect4(eventId);
	check('delete succeeded', del.ok, del.ok ? '' : del.error);
	for (const [table, label] of [
		['vs_connect4_pieces', 'pieces'],
		['vs_connect4_progress', 'progress rows'],
		['vs_dink_drops', 'dink drops'],
		['vs_event_tracked_items', 'tracked items'],
		['vs_event_signups', 'signups']
	]) {
		const { data } = await sb.from(table).select('id').eq('event_id', eventId).limit(5);
		check(`no orphaned ${label}`, (data ?? []).length === 0, `${(data ?? []).length} left`);
	}
	eventId = null;
} catch (e) {
	console.error('\nDRILL ABORTED:', e.message ?? e);
	exitCode = 1;
} finally {
	if (eventId && sb) {
		try {
			const c4 = await server.ssrLoadModule('/src/lib/server/connect4.ts');
			await c4.deleteConnect4(eventId);
			console.log('\n(cleaned up the aborted drill game)');
		} catch {}
	}
	await server.close();
}

console.log(`\n═══ RESULT: ${pass} passed, ${failures.length} failed ═══`);
for (const f of failures) console.log(`  ✗ ${f}`);
for (const n of notes) console.log(`  • ${n}`);
process.exit(exitCode || (failures.length ? 1 : 0));
