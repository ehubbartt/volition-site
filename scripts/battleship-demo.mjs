// Stand up a TEST Battleship event you can click through by hand — a full-size pool of
// stand-in players, parked at whatever phase you want to start poking at.
//
// This is the companion to scripts/battleship-sim.mjs: the simulation proves the engine
// and deletes after itself, this one LEAVES a game behind for a human to play with.
//
//   npm run demo:battleship                          # 80 in the pool, signups open
//   npm run demo:battleship -- --phase battle        # fast-forward to a live battle
//   npm run demo:battleship -- --players 12 --slug tiny-test
//   npm run demo:battleship -- --delete              # remove it and its rows
//
// Flags:
//   --players N   how many to enrol (default 80 — the size the real event is planned at)
//   --phase P     signup | draft | placement | battle (default signup)
//   --slug S      event slug (default test-battleship)
//   --delete      delete the event and stop
//
// Re-running REPLACES the game at that slug, so it doubles as a reset.
//
// Run it against STAGING. The pool is filled with REAL roster members as stand-ins rather
// than invented accounts: fake rows in vs_users would show up in the member counts and
// rank tables the home page builds from that table, and the staging database receives no
// live Dink traffic (the proxy points at prod), so a real member sitting in a test battle
// here cannot have a drop land in it. Against a database that DOES take live drops, don't
// use this — mint a real event instead.

import { createServer } from 'vite';

// ── args ────────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
	const i = argv.indexOf(`--${name}`);
	return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
};
const has = (name) => argv.includes(`--${name}`);

const PLAYERS = Number(flag('players', 80));
const SLUG = flag('slug', 'test-battleship');
const PHASE = flag('phase', 'signup');
const DELETE_ONLY = has('delete');

const PHASES = ['signup', 'draft', 'placement', 'battle'];
if (!PHASES.includes(PHASE)) {
	console.error(`--phase must be one of: ${PHASES.join(', ')}`);
	process.exit(1);
}
const upTo = (p) => PHASES.indexOf(PHASE) >= PHASES.indexOf(p);

// Fixed seed: the same command twice lays out the same fleets, so "it looked different
// this time" is never something you have to wonder about.
let seed = 8080;
const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);

const server = await createServer({
	server: { middlewareMode: true },
	logLevel: 'error',
	appType: 'custom'
});

let exitCode = 0;
try {
	const bs = await server.ssrLoadModule('/src/lib/server/battleship.ts');
	const rules = await server.ssrLoadModule('/src/lib/battleship/rules.ts');
	const { db } = await server.ssrLoadModule('/src/lib/server/db.ts');
	const sb = db();

	// ── wipe any previous run at this slug ───────────────────────────────────
	const { data: existing } = await sb.from('vs_events').select('id, structure').eq('slug', SLUG).maybeSingle();
	if (existing) {
		// Refuse to delete a real event that happens to share the slug. Only games this
		// script (or the admin's "test" checkbox) marked as tests are ours to remove.
		if (!existing.structure?.battleship?.test) {
			throw new Error(`"${SLUG}" is not a test game — refusing to delete it. Pass a different --slug.`);
		}
		for (const t of ['vs_battleship_arsenal', 'vs_battleship_shots', 'vs_battleship_teams']) {
			await sb.from(t).delete().eq('event_id', existing.id);
		}
		await sb.from('vs_submissions').delete().eq('event_id', existing.id);
		await sb.from('vs_event_signups').delete().eq('event_id', existing.id);
		await sb.from('vs_teams').delete().eq('event_id', existing.id);
		await sb.from('vs_events').delete().eq('id', existing.id);
		console.log(`Removed the previous "${SLUG}".`);
	} else if (DELETE_ONLY) {
		console.log(`No game at "${SLUG}" — nothing to delete.`);
	}
	if (DELETE_ONLY) process.exit(0);

	// ── pick the stand-ins ───────────────────────────────────────────────────
	// You go in first, so the player view has a side and bombs of its own to look at.
	const adminDiscord = (process.env.SUPER_ADMIN_DISCORD_IDS ?? '').split(',')[0].trim();
	const { data: me } = adminDiscord
		? await sb.from('vs_users').select('id, rsn').eq('discord_id', adminDiscord).maybeSingle()
		: { data: null };

	const { data: users } = await sb
		.from('vs_users')
		.select('id, rsn')
		.not('rsn', 'is', null)
		.limit(PLAYERS * 2);
	const rest = (users ?? []).filter((u) => u.id !== me?.id);
	const roster = (me ? [me, ...rest] : rest).slice(0, PLAYERS);
	if (roster.length < Math.min(PLAYERS, 2)) throw new Error(`roster only has ${roster.length} members with an RSN`);
	if (roster.length < PLAYERS) console.log(`⚠ roster only has ${roster.length} members — using those.`);

	// ── create + enrol ───────────────────────────────────────────────────────
	const created = await bs.createBattleship({
		slug: SLUG,
		name: `Battleship test — ${roster.length} players`,
		description:
			'Test event with a full pool of stand-in players. Not a real event — safe to delete from /admin/battleship.',
		ownerUserId: roster[0].id,
		test: true
	});
	if (!created.ok) throw new Error(created.error);
	const eventId = created.value.id;

	await sb.from('vs_event_signups').insert(roster.map((p) => ({ event_id: eventId, user_id: p.id })));
	console.log(`Created ${SLUG} with ${roster.length} in the pool.`);

	// ── fast-forward ─────────────────────────────────────────────────────────
	if (upTo('draft')) {
		const draft = await bs.startDraft({
			eventId,
			captains: [roster[0].id, roster[1].id],
			names: ['Fleet Red', 'Fleet Blue']
		});
		if (!draft.ok) throw new Error(draft.error);
		console.log(`Draft open — captains ${roster[0].rsn} (Red) and ${roster[1].rsn} (Blue).`);
	}

	if (upTo('placement')) {
		const bulk = await bs.autoDraftRemaining(eventId);
		if (!bulk.ok) throw new Error(bulk.error);
		console.log('Pool drafted — placement is open.');
	}

	if (upTo('battle')) {
		const snap = await bs.loadBattleship(SLUG);
		for (const side of [1, 2]) {
			const placed = await bs.placeFleet({ eventId, side, fleet: rules.autoPlace(snap.config.size, rand) });
			if (!placed.ok) throw new Error(`side ${side}: ${placed.error}`);
		}
		const battle = await bs.startBattle(eventId);
		if (!battle.ok) throw new Error(battle.error);

		// Ammunition on both sides, so there is something to fire the moment you open it —
		// one of each tier for you, and a spread for the enemy to shoot back with.
		for (const tier of [1, 2, 3]) {
			await bs.grantBomb({ eventId, side: 1, tier, userId: roster[0].id, note: 'Test drop' });
			await bs.grantBomb({ eventId, side: 2, tier, userId: roster[1].id, note: 'Test drop' });
		}
		// A couple in a teammate's name too, so "Team arsenal" isn't all yours.
		for (const tier of [2, 3]) {
			await bs.grantBomb({ eventId, side: 1, tier, userId: roster[2].id, note: 'Test drop' });
		}
		console.log('Battle open — both sides placed, six bombs banked.');
	}

	const final = await bs.loadBattleship(SLUG);
	console.log(
		`\n${final.config.size}×${final.config.size} board · phase ${final.phase} · ` +
			`sides ${final.sides.map((s) => s.members.length).join(' vs ') || '—'}`
	);
	console.log(`  player view: /events/${SLUG}/battleship`);
	console.log(`  admin:       /admin/battleship/${SLUG}`);
	console.log(`  reset:       npm run demo:battleship -- --phase ${PHASE}`);
	console.log(`  remove:      npm run demo:battleship -- --delete`);
} catch (err) {
	console.error(`\n✗ ${err.message}`);
	exitCode = 1;
} finally {
	await server.close();
	process.exit(exitCode);
}
