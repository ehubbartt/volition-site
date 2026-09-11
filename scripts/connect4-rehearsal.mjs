// FULL-SCALE REHEARSAL on staging: the real event, at the real size, with real accounts.
//
//   node scripts/connect4-rehearsal.mjs            # build it
//   node scripts/connect4-rehearsal.mjs --clean    # delete the last one
//
// Stands up a 40×15 / 600-cell board from the CHECKED-IN planned tile list (the same 244
// tiles the event runs on), seats every staging member across the two sides, and leaves it
// live with a start a few minutes out — so the countdown, the hold and the opening can all
// be watched happening. Prints the slug and a seated NON-ADMIN player's discord id, which
// e2e/connect4-player-journey.spec.ts takes as C4_SLUG and C4_PLAYER to drive the board as
// an ordinary member rather than as the admin wearing a member's hat.
//
// Leaves the game behind on purpose — it is there to be clicked through.

import { createServer } from 'vite';

const clean = process.argv.includes('--clean');
const OPENS_IN_MIN = Number(process.env.OPENS_IN_MIN ?? 3);
const SLUG = process.env.C4_SLUG ?? 'rehearsal';

const server = await createServer({ server: { middlewareMode: true }, logLevel: 'error', appType: 'custom' });
try {
	const c4 = await server.ssrLoadModule('/src/lib/server/connect4.ts');
	const imp = await server.ssrLoadModule('/src/lib/server/connect4Import.ts');
	const { db } = await server.ssrLoadModule('/src/lib/server/db.ts');
	const sb = db();

	const existing = await c4.loadConnect4(SLUG);
	if (existing) {
		console.log(`Removing the previous ${SLUG}…`);
		await sb.from('vs_event_signups').delete().eq('event_id', existing.id);
		await sb.from('vs_connect4_pieces').delete().eq('event_id', existing.id);
		await sb.from('vs_teams').delete().eq('event_id', existing.id);
		await sb.from('vs_events').delete().eq('id', existing.id);
	}
	if (clean) {
		console.log('Cleaned.');
		process.exit(0);
	}

	// Everyone on staging with a name, split down the middle — the shape of a 120v120.
	const { data: users } = await sb
		.from('vs_users')
		.select('id, rsn, discord_id')
		.not('rsn', 'is', null)
		.order('rsn');
	if (!users?.length) throw new Error('no users on staging to seat');

	const created = await c4.createConnect4({
		slug: SLUG,
		name: 'Volition vs IronClad — rehearsal',
		description: 'Full-scale rehearsal of the real event. Safe to delete.',
		ownerUserId: users[0].id,
		test: true
	});
	if (!created.ok) throw new Error(created.error);
	const eventId = created.value.id;

	// The real tile list, from the repo — not a generated stand-in.
	const planned = imp.plannedTiles();
	const { pool, custom } = imp.toPoolAndCustom(planned);
	for (const t of custom) {
		await c4.addCustomTile({
			eventId,
			item_name: t.item_name,
			source: t.source,
			any_of: t.included ?? [],
			qty: t.qty ?? 1
		});
	}
	const fresh = await c4.loadConnect4(SLUG);
	const byName = new Map((fresh.custom ?? []).map((t) => [t.item_name.toLowerCase(), t]));
	const tiles = pool.map((t) => byName.get(t.item_name.toLowerCase()) ?? t);
	const set = await c4.setPool(eventId, tiles);
	if (!set.ok) throw new Error(`pool: ${set.error}`);

	const half = Math.ceil(users.length / 2);
	const sideA = users.slice(0, half).map((u) => u.id);
	const sideB = users.slice(half).map((u) => u.id);
	for (const [side, ids] of [[1, sideA], [2, sideB]]) {
		for (let i = 0; i < ids.length; i += 100) {
			const res = await c4.enrolMembers({ eventId, userIds: ids.slice(i, i + 100), side });
			if (!res.ok) throw new Error(`seating: ${res.error}`);
		}
	}

	const opensAt = new Date(Date.now() + OPENS_IN_MIN * 60_000);
	const started = await c4.startGame(eventId, undefined, opensAt.toISOString());
	if (!started.ok) throw new Error(started.error);

	const snap = await c4.loadConnect4(SLUG);
	const admins = new Set(
		(process.env.SUPER_ADMIN_DISCORD_IDS ?? '').split(',').map((s) => s.trim()).filter(Boolean)
	);
	const player = users.find((u) => u.discord_id && !admins.has(u.discord_id));

	console.log('');
	console.log(`  slug          ${SLUG}`);
	console.log(`  board         ${snap.cols}×${snap.rows} = ${snap.cols * snap.rows} cells`);
	console.log(`  tiles         ${planned.length} distinct, ${snap.deckSize} deck slots`);
	console.log(`  seated        ${snap.sides[0].members.length} vs ${snap.sides[1].members.length}`);
	console.log(`  scoring       ${snap.scoring.line_mode}, ${snap.scoring.tile_points}/tile`);
	console.log(`  opens         ${opensAt.toLocaleTimeString()} (${OPENS_IN_MIN} min)`);
	console.log(`  admin         /admin/connect4/${SLUG}`);
	console.log(`  board page    /events/${SLUG}/connect4`);
	console.log('');
	console.log(`  a seated player  ${player?.rsn ?? '?'} (discord ${player?.discord_id ?? '?'})`);
	console.log('');
	console.log('  Drive the whole event as that player AND as an admin:');
	console.log(
		`    C4_PLAYER=${player?.discord_id ?? ''} C4_PLAYER_RSN=${JSON.stringify(player?.rsn ?? '')} \\
      npx playwright test e2e/connect4-player-journey.spec.ts`
	);
} finally {
	await server.close();
}
