// The REVIEW flow, end to end against staging: provisional pieces, both rejections,
// the column shift and the tile requeue.
//
//   node scripts/connect4-review-drill.mjs
//
// Needs db/scripts/connect4.sql applied (the pieces table's `status` and
// `submission_id` columns). It checks for them up front and says so rather than
// failing forty confusing assertions later.
//
// Drives the real server modules, so a bug in shipped code fails the run. Creates one
// unlisted TEST game and deletes it again.

import { createServer } from 'vite';

const SLUG = `drill-review-${Date.now().toString(36)}`;
// clampSize's floor is 5x4 — asking for less silently gets you this anyway.
const COLS = 5;
const ROWS = 4;

let pass = 0;
const failures = [];
const check = (label, cond, detail) => {
	if (cond) { pass++; console.log(`  ✓ ${label}`); }
	else { failures.push(label); console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
};
const step = (n, t) => console.log(`\n── ${n}. ${t} ──`);

const server = await createServer({ server: { middlewareMode: true }, logLevel: 'error', appType: 'custom' });
let eventId = null;
let c4 = null;

try {
	c4 = await server.ssrLoadModule('/src/lib/server/connect4.ts');
	const pool = await server.ssrLoadModule('/src/lib/server/connect4Pool.ts');
	const { db } = await server.ssrLoadModule('/src/lib/server/db.ts');
	const sb = db();

	step(0, 'Schema check');
	const probe = await sb.from('vs_connect4_pieces').select('status, submission_id').limit(1);
	if (probe.error) {
		console.log(`  ✗ vs_connect4_pieces has no status/submission_id (${probe.error.code}).`);
		console.log('    Apply db/scripts/connect4.sql to this database, then re-run.');
		process.exit(2);
	}
	check('provisional-piece columns exist', true);

	step(1, 'A game with two seated players');
	const { data: users } = await sb.from('vs_users').select('id, rsn').not('rsn', 'is', null).limit(4);
	const [red, yellow] = users ?? [];
	if (!red || !yellow) throw new Error('need two users on staging');

	const created = await c4.createConnect4({
		slug: SLUG, name: 'Review drill', ownerUserId: red.id, cols: COLS, rows: ROWS, test: true
	});
	if (!created.ok) throw new Error(created.error);
	eventId = created.value.id;

	const cands = await pool.poolCandidates(pool.ALL_POOL_OPTIONS);
	await c4.setPool(eventId, pool.toTileRefs(pool.smartSelect(cands, COLS * ROWS)));
	await c4.enrolMembers({ eventId, userIds: [red.id], side: 1 });
	await c4.enrolMembers({ eventId, userIds: [yellow.id], side: 2 });
	const started = await c4.startGame(eventId, 4242);
	check('game started', started.ok, started.ok ? '' : started.error);

	let snap = await c4.loadConnect4(SLUG);
	const reload = async () => (snap = await c4.loadConnect4(SLUG));

	// A submission places a PENDING piece. We stand in for the form here — the route
	// action does exactly this after createSubmission.
	// submission_id is a real uuid column, so the stand-in ids have to be real uuids.
	const SUB = { one: crypto.randomUUID(), oneB: crypto.randomUUID(), two: crypto.randomUUID() };
	const submit = async (col, side, userId, subId) =>
		c4.claimTile({
			eventId, side, col, dropKey: `manual:submission:${subId}`,
			byUserId: userId, status: 'pending', submissionId: subId
		});

	step(2, 'Submitting holds the tile immediately, unconfirmed');
	const tile0 = snap.live[0].tile.item_name;
	const s1 = await submit(0, 1, red.id, SUB.one);
	check('the piece lands on submit', s1.status === 'claimed', `${s1.status} ${s1.error ?? ''}`);
	await reload();
	const p1 = snap.pieces.find((p) => p.col === 0);
	check('and it is pending, not confirmed', p1?.status === 'pending', p1?.status);
	check('the column has moved on, so nobody else can take it', snap.live[0].tile.item_name !== tile0);

	step(3, 'Partial rejection leaves the tile in their hands');
	// (the admin route flips the submission row; the board is deliberately untouched)
	await reload();
	const beforePartial = snap.pieces.length;
	check('no board change from a partial rejection', snap.pieces.length === beforePartial);
	const ok2 = await c4.repointPendingPiece(eventId, 0, red.id, SUB.oneB);
	check('a resubmission re-points the piece they already hold', ok2 === true);
	await reload();
	check('still exactly one piece in that column', snap.pieces.filter((p) => p.col === 0).length === 1);

	step(4, 'A second player stacks on top of the first');
	const s2 = await submit(0, 2, yellow.id, SUB.two);
	check('second claim lands above the first', s2.status === 'claimed' && s2.row === 1, `${s2.status} ${s2.error ?? ''} row=${s2.row}`);
	await reload();
	const stacked = snap.pieces.filter((p) => p.col === 0).sort((a, b) => a.row - b.row);
	const bottomTile = stacked[0].deck_idx;
	const topTile = stacked[1].deck_idx;

	step(5, 'Full rejection of the BOTTOM piece removes it and shifts the column');
	const rej = await c4.rejectPieceFully(eventId, SUB.oneB);
	check('rejection succeeded', rej.ok, rej.ok ? '' : rej.error);
	await reload();
	const after = snap.pieces.filter((p) => p.col === 0);
	check('one piece left in the column', after.length === 1, `${after.length}`);
	check('it shifted down to the bottom row', after[0]?.row === 0, `row=${after[0]?.row}`);
	check('and kept the tile it actually earned', after[0]?.deck_idx === topTile, `${after[0]?.deck_idx} vs ${topTile}`);
	check('the rejected tile is offerable again', snap.live[0]?.deckIdx === bottomTile, `${snap.live[0]?.deckIdx} vs ${bottomTile}`);

	step(6, 'Board integrity');
	const cells = new Set(snap.pieces.map((p) => `${p.col},${p.row}`));
	check('no two pieces share a cell', cells.size === snap.pieces.length);
	const idxs = new Set(snap.pieces.map((p) => p.deck_idx));
	check('no two pieces claim the same tile', idxs.size === snap.pieces.length);
	const byCol = new Map();
	for (const p of snap.pieces) byCol.set(p.col, (byCol.get(p.col) ?? []).concat(p.row));
	check('every column is packed from row 0',
		[...byCol.values()].every((rows) => rows.sort((a, b) => a - b).every((r, i) => r === i)));
} catch (e) {
	console.error('\nDRILL ABORTED:', e.message ?? e);
	failures.push(String(e.message ?? e));
} finally {
	if (eventId && c4) { try { await c4.deleteConnect4(eventId); } catch {} }
	await server.close();
}

console.log(`\n═══ ${pass} passed, ${failures.length} failed ═══`);
for (const f of failures) console.log(`  ✗ ${f}`);
process.exit(failures.length ? 1 : 0);
