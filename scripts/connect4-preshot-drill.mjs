// THE TILES THAT NEED A "BEFORE" SCREENSHOT.
//
//   node scripts/connect4-preshot-drill.mjs
//
// 66 of the planned board's 244 tiles are counters, laps, marks, casket loot or things
// already sitting in a bank — an "after" screenshot alone proves nothing about what was
// earned during the event. They are highlighted in the planning workbook and carry `pre`
// in the checked-in list.
//
// The catch this drill exists for: a LIVE game holds its own copy of every tile, taken at
// deal time, so changing the list does nothing for a board already in play. `applyPreShots`
// stamps the flag by name without re-dealing, and that is what has to be proven — on a
// board with pieces already on it.

import { createServer } from 'vite';

const SLUG = `drill-pre-${Date.now().toString(36)}`;
const COLS = 5;
const ROWS = 4;

let pass = 0;
const failures = [];
const check = (label, cond, detail) => {
	if (cond) { pass++; console.log(`  ✓ ${label}`); }
	else { failures.push(label + (detail ? ` — ${detail}` : '')); console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
};
const step = (n, t) => console.log(`\n── ${n}. ${t} ──`);

const server = await createServer({ server: { middlewareMode: true }, logLevel: 'error', appType: 'custom' });
let eventId = null;
let c4 = null;

try {
	c4 = await server.ssrLoadModule('/src/lib/server/connect4.ts');
	const imp = await server.ssrLoadModule('/src/lib/server/connect4Import.ts');
	const { db } = await server.ssrLoadModule('/src/lib/server/db.ts');
	const sb = db();

	step(1, 'The checked-in list carries the flag');
	const planned = imp.plannedTiles();
	const flagged = planned.filter((t) => t.pre);
	check('every planned tile is still there', planned.length === 244, `${planned.length}`);
	check('66 of them need a before screenshot', flagged.length === 66, `${flagged.length}`);
	const cells = flagged.reduce((n, t) => n + t.copies, 0);
	check('which is 124 board cells', cells === 124, `${cells}`);
	check(
		'the banked-unsireds tile carries its note',
		flagged.find((t) => /abyssal head/i.test(t.name))?.preNote?.includes('banked'),
		`${flagged.find((t) => /abyssal head/i.test(t.name))?.preNote}`
	);
	// Spot-check the kinds of tile this is for, by name, so a regenerated list that quietly
	// drops the highlighting fails here rather than on the day.
	for (const name of ['MTA Alchemy Points', 'Rooftop Course Laps', 'Hallowed Marks', 'Gold Nuggets']) {
		check(`"${name}" needs a before shot`, flagged.some((t) => t.name === name));
	}
	check('a plain drop tile does NOT', !flagged.some((t) => t.name === 'Twisted Bow'));

	step(2, 'The flag survives the trip onto a board');
	const { data: users } = await sb.from('vs_users').select('id').limit(1);
	const owner = users?.[0]?.id;
	if (!owner) throw new Error('no users on staging');
	const created = await c4.createConnect4({
		slug: SLUG, name: 'Pre-shot drill', ownerUserId: owner, cols: COLS, rows: ROWS, test: true
	});
	if (!created.ok) throw new Error(created.error);
	eventId = created.value.id;

	// A deck of exactly the tiles under test: some flagged, some not.
	const noted = flagged.find((t) => t.preNote);
	const picks = [
		noted,
		...flagged.filter((t) => t !== noted).slice(0, 9),
		...planned.filter((t) => !t.pre).slice(0, 10)
	];
	const { pool, custom } = imp.toPoolAndCustom(picks.map((t) => ({ ...t, copies: 1 })));
	check('the mapper carries pre_shot onto the tile', pool.filter((t) => t.pre_shot).length === 10,
		`${pool.filter((t) => t.pre_shot).length}`);
	check('and the note with it', pool.some((t) => t.pre_note));
	for (const t of custom) {
		await c4.addCustomTile({ eventId, item_name: t.item_name, source: t.source, any_of: (t.any_of ?? []).map((g) => g.item_name), qty: t.qty ?? 1 });
	}
	const fresh = await c4.loadConnect4(SLUG);
	const byName = new Map((fresh.custom ?? []).map((t) => [t.item_name.toLowerCase(), t]));
	// Deal it WITHOUT the flag — that is the state the real event is in, dealt from a list
	// that did not carry it yet. The point of step 3 is putting it on afterwards.
	const bare = ({ pre_shot, pre_note, ...rest }) => rest;
	const deck = pool.map((t) => bare(byName.get(t.item_name.toLowerCase()) ?? t));
	await c4.setPool(eventId, deck.slice(0, COLS * ROWS));
	await c4.enrolMembers({ eventId, userIds: [owner], side: 1 });
	await c4.startGame(eventId);

	let snap = await c4.loadConnect4(SLUG);
	check('the game is live', snap.phase === 'live');
	// addCustomTile does not know about pre_shot, so a dealt board starts WITHOUT it —
	// which is exactly the state the real event is in.
	const before = snap.deck.filter((t) => t.pre_shot).length;
	check('the board starts WITHOUT the flag, as the real one did', before === 0, `${before}`);

	step(3, 'Stamping a board that is already in play');
	await c4.creditManual({ eventId, side: 1, col: 0 });
	snap = await c4.loadConnect4(SLUG);
	const deckBefore = snap.deck.map((t) => t.item_name).join('|');
	const piecesBefore = snap.pieces.length;

	const names = planned.filter((t) => t.pre).map((t) => ({ name: t.name, note: t.preNote ?? null }));
	const res = await c4.applyPreShots(eventId, names);
	check('the stamp ran', res.ok, res.ok ? '' : res.error);

	snap = await c4.loadConnect4(SLUG);
	check('tiles now ask for a before screenshot', snap.deck.filter((t) => t.pre_shot).length > before,
		`${before} → ${snap.deck.filter((t) => t.pre_shot).length}`);
	// The part that would ruin an event: the deal itself must not move.
	check('the deck is in the SAME order', snap.deck.map((t) => t.item_name).join('|') === deckBefore);
	check('no piece was disturbed', snap.pieces.length === piecesBefore, `${snap.pieces.length}`);
	check('an unflagged tile is left alone', snap.deck.some((t) => !t.pre_shot));
	check('the live rail carries the flag', snap.live.some((t) => t?.tile.pre_shot));

	const again = await c4.applyPreShots(eventId, names);
	snap = await c4.loadConnect4(SLUG);
	check('running it twice changes nothing more', again.ok && again.value.cells === res.value.cells,
		`${res.value?.cells} then ${again.value?.cells}`);
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
