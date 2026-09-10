// WHO THE TEAMS PANEL CAN ACT ON, against staging.
//
//   node scripts/connect4-roster-drill.mjs
//
// The reported bug: members could not be taken off the event. The panel's list came from
// "every site account that has an RSN", so anyone seated WITHOUT one — an opposing-clan
// member part-way through onboarding, or someone whose RSN was cleared when they left —
// was on a side and yet had no row to tick. Remove could not reach them, which on screen
// looks exactly like a dead button.
//
// Drives the real server modules, so a bug in shipped code fails the run. Creates one
// unlisted TEST game and one throwaway user, and deletes both again.

import { createServer } from 'vite';

const SLUG = `drill-roster-${Date.now().toString(36)}`;
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
let namelessId = null;
let c4 = null;
let sb = null;

try {
	c4 = await server.ssrLoadModule('/src/lib/server/connect4.ts');
	const { db } = await server.ssrLoadModule('/src/lib/server/db.ts');
	sb = db();

	step(1, 'A game with a named member and a nameless one');
	const { data: users } = await sb.from('vs_users').select('id, rsn').not('rsn', 'is', null).limit(2);
	const [named, other] = users ?? [];
	if (!named || !other) throw new Error('need two users with an RSN on staging');

	const created = await c4.createConnect4({
		slug: SLUG, name: 'Roster drill', ownerUserId: named.id, cols: COLS, rows: ROWS, test: true
	});
	check('game created', created.ok, created.ok ? '' : created.error);
	if (!created.ok) throw new Error(created.error);
	eventId = created.value.id;

	// A site account with NO RSN — exactly what the roster query filters out.
	const { data: nameless, error: mkErr } = await sb
		.from('vs_users')
		.insert({ discord_id: `drill-${Date.now()}`, discord_username: 'roster-drill', rsn: null })
		.select('id')
		.single();
	if (mkErr) throw new Error(`could not make a nameless user: ${mkErr.message}`);
	namelessId = nameless.id;
	check('a site account with no RSN exists', !!namelessId);

	step(2, 'Seat both, one of them nameless');
	const seated = await c4.enrolMembers({ eventId, userIds: [named.id, namelessId], side: 2 });
	check('both seated on side 2', seated.ok, seated.ok ? '' : seated.error);

	let snap = await c4.loadConnect4(SLUG);
	check('the game counts two on side 2', snap.sides[1].members.length === 2, `${snap.sides[1].members.length}`);

	step(3, 'The panel can see everyone the game has');
	let roster = await c4.rosterFor(snap);
	const rowFor = (id) => roster.find((r) => r.id === id);
	check('the named member has a row', !!rowFor(named.id));
	// THE BUG: this row did not exist, so the member could not be ticked or removed.
	check('the NAMELESS member has a row too', !!rowFor(namelessId), 'missing from the roster');
	check('the nameless row is marked as on the event', rowFor(namelessId)?.inEvent === true);
	check('the nameless row carries its side', rowFor(namelessId)?.side === 2, `${rowFor(namelessId)?.side}`);
	check('someone not on the event is listed but unflagged', rowFor(other.id)?.inEvent === false);
	check('nobody is listed twice', new Set(roster.map((r) => r.id)).size === roster.length);
	check('rows with a name sort before the nameless', (roster.at(-1)?.rsn ?? null) === null);

	step(4, 'Remove reaches the nameless member');
	const gone = await c4.removeFromEvent({ eventId, userIds: [namelessId] });
	check('the removal reports one gone', gone.ok && gone.value.removed === 1, `${gone.value?.removed}`);

	snap = await c4.loadConnect4(SLUG);
	check('side 2 is down to one member', snap.sides[1].members.length === 1, `${snap.sides[1].members.length}`);
	roster = await c4.rosterFor(snap);
	check('the nameless member is off the event', rowFor(namelessId) === undefined || roster.find((r) => r.id === namelessId)?.inEvent === false);

	step(5, 'And removing the named one empties the side');
	const gone2 = await c4.removeFromEvent({ eventId, userIds: [named.id] });
	check('the removal reports one gone', gone2.ok && gone2.value.removed === 1, `${gone2.value?.removed}`);
	snap = await c4.loadConnect4(SLUG);
	check('no one is left on either side', snap.sides.every((s) => !s.members.length));
	check('and no one is left unassigned', !snap.unassigned.length, `${snap.unassigned.length}`);

	const again = await c4.removeFromEvent({ eventId, userIds: [named.id] });
	check('removing someone already off it removes nothing', again.ok && again.value.removed === 0, `${again.value?.removed}`);
} catch (e) {
	console.error('\nDRILL ABORTED:', e.message ?? e);
	failures.push(String(e.message ?? e));
} finally {
	if (eventId && c4) { try { await c4.deleteConnect4(eventId); } catch {} }
	if (namelessId && sb) { try { await sb.from('vs_users').delete().eq('id', namelessId); } catch {} }
	await server.close();
}

console.log(`\n═══ ${pass} passed, ${failures.length} failed ═══`);
for (const f of failures) console.log(`  ✗ ${f}`);
process.exit(failures.length ? 1 : 0);
