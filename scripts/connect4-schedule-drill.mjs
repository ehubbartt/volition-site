// ONE EVENT, TWO ROWS: a Connect Four board seated from a signup form runs to that form's
// clock. The deck can be dealt the night before; nothing opens, and nothing counts, until
// the announced start.
//
//   node scripts/connect4-schedule-drill.mjs
//
// Drives the real server modules, so a bug in shipped code fails the run. Creates one
// unlisted TEST game and one throwaway signup event, and deletes both again.

import { createServer } from 'vite';

const SLUG = `drill-sched-${Date.now().toString(36)}`;
const COLS = 5;
const ROWS = 4;
const HOUR = 3600_000;

let pass = 0;
const failures = [];
const check = (label, cond, detail) => {
	if (cond) { pass++; console.log(`  ✓ ${label}`); }
	else { failures.push(label + (detail ? ` — ${detail}` : '')); console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
};
const step = (n, t) => console.log(`\n── ${n}. ${t} ──`);

const server = await createServer({ server: { middlewareMode: true }, logLevel: 'error', appType: 'custom' });
let eventId = null;
let signupId = null;
let c4 = null;
let sb = null;

try {
	c4 = await server.ssrLoadModule('/src/lib/server/connect4.ts');
	const pool = await server.ssrLoadModule('/src/lib/server/connect4Pool.ts');
	const { db } = await server.ssrLoadModule('/src/lib/server/db.ts');
	sb = db();

	step(1, 'A signup form that starts in an hour, with two people on it');
	const { data: users } = await sb.from('vs_users').select('id, rsn').not('rsn', 'is', null).limit(2);
	const [a, b] = users ?? [];
	if (!a || !b) throw new Error('need two users with an RSN on staging');

	const openAt = new Date(Date.now() + HOUR).toISOString();
	const { data: signup, error: sErr } = await sb
		.from('vs_events')
		.insert({
			slug: `${SLUG}-form`,
			name: `Schedule drill form`,
			kind: 'signup',
			status: 'open',
			starts_at: openAt,
			structure: {}
		})
		.select('id')
		.single();
	if (sErr) throw new Error(`could not make a signup event: ${sErr.message}`);
	signupId = signup.id;
	await sb.from('vs_event_signups').insert([
		{ event_id: signupId, user_id: a.id },
		{ event_id: signupId, user_id: b.id }
	]);
	check('the form starts in an hour', true, new Date(openAt).toLocaleTimeString());

	step(2, 'A board seated from it remembers where its roster came from');
	const created = await c4.createConnect4({
		slug: SLUG, name: 'Schedule drill', ownerUserId: a.id, cols: COLS, rows: ROWS, test: true
	});
	if (!created.ok) throw new Error(created.error);
	eventId = created.value.id;

	const seated = await c4.seatByClan({ eventId, sourceEventId: signupId, clanSide: 1 });
	check('seating from the form worked', seated.ok, seated.ok ? '' : seated.error);
	let snap = await c4.loadConnect4(SLUG);
	check('the game knows its source form', snap.sourceEventId === signupId, `${snap.sourceEventId}`);
	check('both people are on the board', snap.sides.flatMap((s) => s.members).length === 2);

	step(3, 'Dealing now still opens at the form’s time');
	const cands = await pool.poolCandidates(pool.ALL_POOL_OPTIONS);
	const fill = async (id) => c4.setPool(id, pool.toTileRefs(pool.smartSelect(cands, COLS * ROWS)));
	const filled = await fill(eventId);
	check('the pool filled', filled.ok, filled.ok ? '' : filled.error);
	const started = await c4.startGame(eventId);
	check('the deck dealt', started.ok, started.ok ? '' : started.error);

	snap = await c4.loadConnect4(SLUG);
	check('the board is live', snap.phase === 'live', snap.phase);
	check(
		'but it opens when the FORM opens, not now',
		new Date(snap.startsAt).getTime() === new Date(openAt).getTime(),
		`${snap.startsAt} vs ${openAt}`
	);
	check('and it is not open yet', c4.hasOpened(snap) === false);

	step(4, 'A started game is ON the events page');
	// A game is created UNLISTED so a half-built board is not on display, and nothing used
	// to clear that — a real game could be live, open, and invisible to the whole clan.
	check('a test game stays off the events page', snap.unlisted === true, `unlisted=${snap.unlisted}`);
	// The real thing: a non-test game, which is what an actual event is.
	const realOne = await c4.createConnect4({
		slug: `${SLUG}-real`, name: 'Schedule drill real', ownerUserId: a.id, cols: COLS, rows: ROWS
	});
	if (!realOne.ok) throw new Error(realOne.error);
	const realId = realOne.value.id;
	try {
		await c4.enrolMembers({ eventId: realId, userIds: [a.id], side: 1 });
		await fill(realId);
		const go = await c4.startGame(realId);
		check('a real game starts', go.ok, go.ok ? '' : go.error);
		const { data: evRow } = await sb
			.from('vs_events')
			.select('status, unlisted')
			.eq('id', realId)
			.maybeSingle();
		check('its status is open', evRow?.status === 'open', `${evRow?.status}`);
		check('and it is listed, so /events shows it', evRow?.unlisted === false, `unlisted=${evRow?.unlisted}`);
		check('it can be hidden by hand', (await c4.setListed(realId, false)).ok);
		check('and shown again', (await c4.loadConnect4(`${SLUG}-real`)).unlisted === true
			&& (await c4.setListed(realId, true)).ok
			&& (await c4.loadConnect4(`${SLUG}-real`)).unlisted === false);
	} finally {
		// Deleted at the row, not through deleteConnect4 — that refuses a non-test game.
		await sb.from('vs_connect4_pieces').delete().eq('event_id', realId).catch?.(() => {});
		await sb.from('vs_event_signups').delete().eq('event_id', realId);
		await sb.from('vs_events').delete().eq('id', realId);
	}

	step(5, 'Until the start it gives nothing away and takes nothing');
	const seenByMember = c4.redactSnapshot(snap, false);
	check('a member sees no undealt deck', seenByMember.deck.length === 0);
	// The one that matters: a board dealt early must not leak the 40 tiles on offer.
	check(
		'a member sees NO tiles on offer either',
		seenByMember.live.every((t) => t === null),
		`${seenByMember.live.filter(Boolean).length} leaked`
	);
	check('an admin still sees the board', c4.redactSnapshot(snap, true).live.some(Boolean));

	const early = await c4.creditManual({ eventId, side: 1, col: 0 });
	check('a claim before the start is refused', early.status === 'not_live', early.status);
	snap = await c4.loadConnect4(SLUG);
	check('and nothing landed on the board', snap.pieces.length === 0, `${snap.pieces.length}`);

	step(6, 'On the stroke, everything opens');
	await sb.from('vs_events').update({ starts_at: new Date(Date.now() - 1000).toISOString() }).eq('id', eventId);
	snap = await c4.loadConnect4(SLUG);
	check('the board has opened', c4.hasOpened(snap) === true);
	check('the tiles are visible to members', c4.redactSnapshot(snap, false).live.some(Boolean));
	const onTime = await c4.creditManual({ eventId, side: 1, col: 0 });
	check('a claim now lands', onTime.status === 'claimed', onTime.status);

	step(7, 'A time given by hand beats the inherited one, and nonsense is refused');
	const later = new Date(Date.now() + 2 * HOUR).toISOString();
	const second = await c4.createConnect4({
		slug: `${SLUG}-2`, name: 'Schedule drill 2', ownerUserId: a.id, cols: COLS, rows: ROWS, test: true
	});
	if (!second.ok) throw new Error(second.error);
	const id2 = second.value.id;
	try {
		await c4.seatByClan({ eventId: id2, sourceEventId: signupId, clanSide: 1 });
		await fill(id2);
		const bad = await c4.startGame(id2, undefined, 'not a date');
		check('a start time that is not a date is refused', !bad.ok, bad.ok ? 'accepted' : bad.error);
		const ok2 = await c4.startGame(id2, undefined, later);
		check('an explicit time is taken', ok2.ok, ok2.ok ? '' : ok2.error);
		const snap2 = await c4.loadConnect4(`${SLUG}-2`);
		check(
			'and it wins over the form’s time',
			new Date(snap2.startsAt).getTime() === new Date(later).getTime(),
			`${snap2.startsAt} vs ${later}`
		);
	} finally {
		await c4.deleteConnect4(id2).catch(() => {});
	}

	step(8, 'A game with no form behind it starts the moment it is dealt');
	const third = await c4.createConnect4({
		slug: `${SLUG}-3`, name: 'Schedule drill 3', ownerUserId: a.id, cols: COLS, rows: ROWS, test: true
	});
	if (!third.ok) throw new Error(third.error);
	try {
		await c4.enrolMembers({ eventId: third.value.id, userIds: [a.id], side: 1 });
		await fill(third.value.id);
		await c4.startGame(third.value.id);
		const snap3 = await c4.loadConnect4(`${SLUG}-3`);
		check('it has no source', snap3.sourceEventId === null);
		check('and it is open straight away', c4.hasOpened(snap3) === true);
	} finally {
		await c4.deleteConnect4(third.value.id).catch(() => {});
	}
} catch (e) {
	console.error('\nDRILL ABORTED:', e.message ?? e);
	failures.push(String(e.message ?? e));
} finally {
	if (eventId && c4) { try { await c4.deleteConnect4(eventId); } catch {} }
	if (signupId && sb) {
		try { await sb.from('vs_event_signups').delete().eq('event_id', signupId); } catch {}
		try { await sb.from('vs_events').delete().eq('id', signupId); } catch {}
	}
	await server.close();
}

console.log(`\n═══ ${pass} passed, ${failures.length} failed ═══`);
for (const f of failures) console.log(`  ✗ ${f}`);
process.exit(failures.length ? 1 : 0);
