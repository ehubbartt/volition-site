// A dedicated, deterministic Connect Four game for browser testing.
//
//   node scripts/c4-qa-lab.mjs create     # build + start the game, print the cast
//   node scripts/c4-qa-lab.mjs info       # board state, progress banks, submissions
//   node scripts/c4-qa-lab.mjs delete     # tear it down
//
// Test-only: builds an unlisted TEST game on whatever Supabase the shell points at
// (staging — see docs/DEV-PREVIEW.md). It exists so the browser specs have a board
// small enough to reason about, with one tile of every interesting shape sitting in a
// known column:
//
//   A  ×1 plain item (real wiki art)
//   B  ×5 quantity tile      — small enough to walk to completion, ×3 behind it
//   C  ×1000 quantity tile   — proves partial cover does NOT complete a tile
//   D  before-screenshot tile (pre_shot + pre_note)
//   E  ×1, for the contested-claim race
//   F  ×1, for the full rejection
//
// The cast is three players a side, one signed up but unseated, and one outsider.
//
// The deck is dealt by the real startGame and then OVERWRITTEN with a fixed order, so
// slot c*rows+n is known. Nothing else about the game is special.

import { createServer } from 'vite';

const SLUG = process.env.C4_QA_SLUG ?? 'c4-qa-lab';
const COLS = 6;
const ROWS = 4;
const cmd = process.argv[2] ?? 'create';

const plain = (n, name, source, ehb) => ({ item_id: -n, item_name: name, source, ehb });

// One row per deck slot, in slot order. Column c owns slots [c*ROWS, c*ROWS+ROWS).
const DECK = [
	// A — plain ×1, real items so the wiki proxy has something to resolve
	plain(101, 'Bandos chestplate', 'General Graardor', 12),
	plain(102, 'Armadyl crossbow', 'Commander Zilyana', 18),
	plain(103, 'Zamorakian spear', "K'ril Tsutsaroth", 9),
	plain(104, 'Dragon warhammer', 'Lizardman shaman', 30),
	// B — the small quantity tile
	{ ...plain(201, 'QA Mixology Points', 'Mastering Mixology', 4), qty: 5 },
	{ ...plain(202, 'QA Wintertodt Kits', 'Wintertodt', 6), qty: 3 },
	plain(203, 'Dragon boots', 'Spiritual mage', 5),
	plain(204, 'Berserker ring', 'Dagannoth Rex', 14),
	// C — the large quantity tile
	{ ...plain(301, 'QA Stardust Haul', 'Shooting Stars', 20), qty: 1000 },
	plain(302, 'Tyrannical ring', 'Callisto', 11),
	plain(303, 'Odium shard 1', 'Chaos Elemental', 8),
	plain(304, 'Granite maul', 'Thermonuclear smoke devil', 7),
	// D — needs a BEFORE screenshot
	{
		...plain(401, 'QA Rooftop Course Laps', 'Rooftop Agility', 10),
		pre_shot: true,
		pre_note: 'your current lap count before you start'
	},
	plain(402, 'Amulet of fury', 'Chaos Fanatic', 9),
	plain(403, 'Occult necklace', 'Smoke devil', 6),
	plain(404, 'Trident of the seas', 'Cave kraken', 5),
	// E — the contested column
	plain(501, 'Ancestral hat', 'Chambers of Xeric', 40),
	plain(502, 'Twisted bow', 'Chambers of Xeric', 90),
	plain(503, 'Kodai insignia', 'Chambers of Xeric', 45),
	plain(504, 'Elder maul', 'Chambers of Xeric', 50),
	// F — the full-rejection column
	plain(601, 'Scythe of vitur', 'Theatre of Blood', 80),
	plain(602, 'Ghrazi rapier', 'Theatre of Blood', 35),
	plain(603, 'Sanguinesti staff', 'Theatre of Blood', 38),
	plain(604, 'Justiciar faceguard', 'Theatre of Blood', 30)
];

const server = await createServer({ server: { middlewareMode: true }, logLevel: 'error', appType: 'custom' });

try {
	const c4 = await server.ssrLoadModule('/src/lib/server/connect4.ts');
	const { db } = await server.ssrLoadModule('/src/lib/server/db.ts');
	const sb = db();

	const existing = await c4.loadConnect4(SLUG);

	if (cmd === 'delete') {
		if (!existing) { console.log('nothing to delete'); process.exit(0); }
		const res = await c4.deleteConnect4(existing.id);
		console.log(res.ok ? `deleted ${SLUG}` : `delete failed: ${res.error}`);
		process.exit(res.ok ? 0 : 1);
	}

	if (cmd === 'info') {
		if (!existing) { console.log(`no game at ${SLUG}`); process.exit(1); }
		console.log(`phase=${existing.phase} starts=${existing.startsAt} pieces=${existing.pieces.length}`);
		for (const p of existing.pieces) {
			console.log(`  ${String.fromCharCode(65 + p.col)}${p.row + 1} side=${p.side} slot=${p.deck_idx} ${p.status} "${p.item_name}" by=${p.by_rsn ?? '—'} sub=${p.submission_id ?? '—'}`);
		}
		const { data: prog } = await sb.from('vs_connect4_progress').select('deck_idx, side, qty, item_name, by_user_id').eq('event_id', existing.id);
		console.log('progress:', JSON.stringify(prog ?? []));
		const { data: subs } = await sb.from('vs_submissions').select('id, status, target_id, quantity, review_note, user_id').eq('event_id', existing.id);
		console.log('submissions:');
		for (const s of subs ?? []) console.log(`  ${s.target_id} qty=${s.quantity} ${s.status} note=${s.review_note ?? '—'} (${s.id})`);
		console.log('live:', existing.live.map((l, i) => `${String.fromCharCode(65 + i)}:${l ? `${l.deckIdx}/${l.tile.item_name}${l.tile.qty > 1 ? ` x${l.tile.qty}` : ''}` : '—'}`).join('  '));
		process.exit(0);
	}

	// ── create ───────────────────────────────────────────────────────────────
	if (existing) {
		const gone = await c4.deleteConnect4(existing.id);
		if (!gone.ok) throw new Error(`could not clear the old ${SLUG}: ${gone.error}`);
	}

	// Six seated players (three a side) plus one signed-up-but-unseated spectator.
	const { data: users } = await sb
		.from('vs_users')
		.select('id, rsn, discord_id')
		.not('rsn', 'is', null)
		.not('discord_id', 'is', null)
		.order('id')
		.limit(40);
	const admins = (process.env.SUPER_ADMIN_DISCORD_IDS ?? '').split(',').map((s) => s.trim());
	const cast = (users ?? []).filter((u) => !admins.includes(u.discord_id)).slice(0, 8);
	if (cast.length < 8) throw new Error('need eight non-admin members with an RSN on this database');

	const owner = cast[0];
	const created = await c4.createConnect4({
		slug: SLUG,
		name: `Connect Four QA lab (${SLUG})`,
		ownerUserId: owner.id,
		cols: COLS,
		rows: ROWS,
		test: true,
		sideNames: ['Volition', 'IronClad']
	});
	if (!created.ok) throw new Error(created.error);
	const eventId = created.value.id;

	const pooled = await c4.setPool(eventId, DECK);
	if (!pooled.ok) throw new Error(pooled.error);

	const red = cast.slice(0, 3);
	const yellow = cast.slice(3, 6);
	const bench = cast[6];
	// Never signed up at all — the pure spectator.
	const outsider = cast[7];
	let r = await c4.enrolMembers({ eventId, userIds: red.map((u) => u.id), side: 1 });
	if (!r.ok) throw new Error(r.error);
	r = await c4.enrolMembers({ eventId, userIds: yellow.map((u) => u.id), side: 2 });
	if (!r.ok) throw new Error(r.error);
	// Signed up, never seated — the "no side" case the claim path has to refuse.
	r = await c4.enrolMembers({ eventId, userIds: [bench.id], side: null });
	if (!r.ok) throw new Error(r.error);

	const started = await c4.startGame(eventId, 1);
	if (!started.ok) throw new Error(started.error);

	// Replace the shuffled deal with the fixed order above, so every spec knows which
	// tile sits over which column. Nothing has been claimed yet, so nothing moves.
	const { data: ev } = await sb.from('vs_events').select('structure').eq('id', eventId).maybeSingle();
	const structure = ev.structure;
	structure.connect4.deck = DECK;
	const { error: upErr } = await sb.from('vs_events').update({ structure }).eq('id', eventId);
	if (upErr) throw new Error(upErr.message);

	const snap = await c4.loadConnect4(SLUG);
	console.log(`\n${SLUG}  (${COLS}x${ROWS}, phase=${snap.phase}, opens ${snap.startsAt})`);
	console.log('board: /events/' + SLUG + '/connect4     admin: /admin/connect4/' + SLUG);
	console.log('\ncast:');
	const line = (label, u) => console.log(`  ${label.padEnd(12)} ${u.discord_id}  ${u.rsn}`);
	red.forEach((u, i) => line(`Volition ${i + 1}`, u));
	yellow.forEach((u, i) => line(`IronClad ${i + 1}`, u));
	line('bench', bench);
	line('outsider', outsider);
	console.log('\nlive tiles:', snap.live.map((l, i) => `${String.fromCharCode(65 + i)}=${l.tile.item_name}${l.tile.qty > 1 ? ` x${l.tile.qty}` : ''}`).join(', '));
	// One machine-readable line, so a spec can build its own board in beforeAll.
	console.log(
		'QA_LAB_JSON=' +
			JSON.stringify({
				slug: SLUG,
				eventId,
				red: red.map((u) => ({ id: u.discord_id, rsn: u.rsn })),
				yellow: yellow.map((u) => ({ id: u.discord_id, rsn: u.rsn })),
				bench: { id: bench.discord_id, rsn: bench.rsn },
				outsider: { id: outsider.discord_id, rsn: outsider.rsn }
			})
	);
} finally {
	await server.close();
}
