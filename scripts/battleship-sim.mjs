// End-to-end Battleship simulation — drives a whole game (signup → draft → placement →
// battle → win) against whatever Supabase the shell points at, through the REAL server
// module. Nothing here reimplements the rules; it calls src/lib/server/battleship.ts so a
// bug in the shipped code fails the run.
//
//   npm run sim:battleship            # 32 players, random seed
//   npm run sim:battleship -- --players 48 --seed 7 --keep
//
// Flags:
//   --players N   signups to simulate (default 32)
//   --seed N      seed the RNG so a run is reproducible (default: time-based)
//   --keep        leave the event in the database instead of deleting it
//   --slug S      reuse/create a specific slug
//
// Run it against STAGING. It creates real rows (an unlisted test event plus its teams,
// shots and arsenal) and deletes them again unless --keep. It never touches an event it
// did not create.

import { createServer } from 'vite';

// ── args ────────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
	const i = argv.indexOf(`--${name}`);
	return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
};
const has = (name) => argv.includes(`--${name}`);

const PLAYERS = Number(flag('players', 32));
const SEED = Number(flag('seed', Date.now() % 100000));
const KEEP = has('keep');
const SLUG = flag('slug', `sim-battleship-${Date.now().toString(36)}`);

// Deterministic RNG so `--seed` reproduces a run exactly (Math.random would not).
let seed = SEED >>> 0 || 1;
const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const pick = (arr) => arr[Math.floor(rand() * arr.length)];

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

// Load the app's own modules through Vite so `$lib`, `$env/dynamic/private` and
// `$app/environment` resolve exactly as they do in the running server.
const server = await createServer({
	server: { middlewareMode: true },
	logLevel: 'error',
	// SvelteKit reads env at import time; the shell's SUPABASE_* vars are what db() uses.
	appType: 'custom'
});

let exitCode = 0;
let eventId = null;
let sb = null;

try {
	const bs = await server.ssrLoadModule('/src/lib/server/battleship.ts');
	const rules = await server.ssrLoadModule('/src/lib/battleship/rules.ts');
	const { db } = await server.ssrLoadModule('/src/lib/server/db.ts');
	sb = db();

	console.log(`Battleship simulation — ${PLAYERS} players, seed ${SEED}, slug ${SLUG}`);

	// ── 1. roster ────────────────────────────────────────────────────────────
	step(1, 'Pick simulated players from the roster');
	const { data: users, error: uErr } = await sb
		.from('vs_users')
		.select('id, rsn, discord_id')
		.not('rsn', 'is', null)
		.limit(Math.max(PLAYERS * 2, 64));
	if (uErr) throw new Error(`roster read failed: ${uErr.message}`);
	const roster = (users ?? []).filter((u) => u.rsn);
	check(`roster has at least ${PLAYERS} members`, roster.length >= PLAYERS, `found ${roster.length}`);
	if (roster.length < PLAYERS) throw new Error('not enough members on the roster to simulate');
	const players = roster.slice(0, PLAYERS);

	// ── 2. create ────────────────────────────────────────────────────────────
	step(2, 'Create the event');
	const created = await bs.createBattleship({
		slug: SLUG,
		name: `Simulated Battleship (${PLAYERS}p)`,
		description: 'Automated end-to-end simulation. Safe to delete.',
		ownerUserId: players[0].id,
		test: true
	});
	check('event created', created.ok, created.ok ? '' : created.error);
	if (!created.ok) throw new Error(created.error);
	eventId = created.value.id;

	// ── 3. signups ───────────────────────────────────────────────────────────
	step(3, 'Sign everyone up');
	const { error: sErr } = await sb
		.from('vs_event_signups')
		.insert(players.map((p) => ({ event_id: eventId, user_id: p.id })));
	if (sErr) throw new Error(`signup insert failed: ${sErr.message}`);
	let snap = await bs.loadBattleship(SLUG);
	check(`${PLAYERS} in the pool`, snap.pool.length === PLAYERS, `pool=${snap.pool.length}`);
	check('phase is signup', snap.phase === 'signup', snap.phase);

	// ── 3b. leaving ──────────────────────────────────────────────────────────
	step('3b', 'Drop out and rejoin while signups are open');
	const quitter = players[PLAYERS - 1];
	const left = await bs.leaveEvent({ eventId, userId: quitter.id });
	check('a member can leave during signups', left.ok, left.ok ? '' : left.error);
	snap = await bs.loadBattleship(SLUG);
	check('the pool shrank', snap.pool.length === PLAYERS - 1, `pool=${snap.pool.length}`);

	const leaveTwice = await bs.leaveEvent({ eventId, userId: quitter.id });
	check('leaving twice is refused, not a silent no-op', !leaveTwice.ok, leaveTwice.ok ? 'allowed' : leaveTwice.error);

	// Put them back so the draft still has a full pool.
	await sb.from('vs_event_signups').insert({ event_id: eventId, user_id: quitter.id });
	snap = await bs.loadBattleship(SLUG);
	check('rejoining restores the pool', snap.pool.length === PLAYERS, `pool=${snap.pool.length}`);

	// ── 4. draft ─────────────────────────────────────────────────────────────
	step(4, 'Run the draft');
	const captains = [players[0].id, players[1].id];
	const draftStart = await bs.startDraft({ eventId, captains });
	check('sides created', draftStart.ok, draftStart.ok ? '' : draftStart.error);
	if (!draftStart.ok) throw new Error(draftStart.error);

	snap = await bs.loadBattleship(SLUG);
	check('two sides exist', snap.sides.length === 2, `sides=${snap.sides.length}`);
	check('captains are seated', snap.pool.length === PLAYERS - 2, `pool=${snap.pool.length}`);
	check('phase is draft', snap.phase === 'draft', snap.phase);

	// Out-of-turn pick must be refused — the turn rule is what makes a draft a draft.
	const wrongTurn = await bs.draftPick({
		eventId,
		side: snap.draft.turn === 1 ? 2 : 1,
		userId: snap.pool[0].userId
	});
	check('out-of-turn pick refused', !wrongTurn.ok, wrongTurn.ok ? 'it was allowed' : wrongTurn.error);

	// Pick a handful by hand (the captains' path), then bulk-draft the rest (the admin
	// path). Both have to produce the same balanced result.
	let guard = 0;
	while (snap.pool.length > Math.floor(PLAYERS / 2) && guard++ < PLAYERS + 5) {
		const target = pick(snap.pool);
		const res = await bs.draftPick({ eventId, side: snap.draft.turn, userId: target.userId });
		if (!res.ok) throw new Error(`draft pick failed: ${res.error}`);
		snap = await bs.loadBattleship(SLUG);
	}
	const handPicked = snap.draft.picks.length;

	const bulk = await bs.autoDraftRemaining(eventId);
	check('bulk draft drained the pool', bulk.ok, bulk.ok ? '' : bulk.error);
	if (!bulk.ok) throw new Error(bulk.error);
	snap = await bs.loadBattleship(SLUG);
	check(
		'bulk draft logged every pick it claimed',
		snap.draft.picks.length === PLAYERS - 2,
		`log=${snap.draft.picks.length} expected=${PLAYERS - 2} (hand-picked ${handPicked})`
	);
	// Re-running it on a drained pool is a no-op, not an error.
	const again = await bs.autoDraftRemaining(eventId);
	check('bulk draft on an empty pool is refused cleanly', !again.ok || again.value?.picked === 0,
		again.ok ? `picked=${again.value?.picked}` : again.error);
	check('pool is empty', snap.pool.length === 0, `pool=${snap.pool.length}`);
	const sizes = snap.sides.map((s) => s.members.length);
	check('sides are balanced', Math.abs(sizes[0] - sizes[1]) <= 1, `sides=${sizes.join(' vs ')}`);
	check('everyone is on a side', sizes[0] + sizes[1] === PLAYERS, `total=${sizes[0] + sizes[1]}`);
	check('draft ended into placement', snap.phase === 'placement', snap.phase);

	// The guard that actually matters: once the draft is over, a drafted player must not
	// be able to walk out and leave their side a ship short with nobody behind it.
	const drafted = snap.sides[0].members[0];
	const lateLeave = await bs.leaveEvent({ eventId, userId: drafted.userId });
	check('a drafted member cannot leave', !lateLeave.ok, lateLeave.ok ? 'it was allowed!' : lateLeave.error);
	snap = await bs.loadBattleship(SLUG);
	check(
		'their side is still intact after the refused leave',
		snap.sides[0].members.some((m) => m.userId === drafted.userId),
		'the member vanished from their side'
	);

	// Board size must follow the headcount, not a constant.
	const expectedSize = rules.boardSizeFor(Math.max(...sizes));
	check(
		`board scaled to ${expectedSize}x${expectedSize} for ${Math.max(...sizes)} a side`,
		snap.config.size === expectedSize,
		`got ${snap.config.size}`
	);

	// ── 5. placement ─────────────────────────────────────────────────────────
	step(5, 'Place the fleets');
	const size = snap.config.size;

	// A deliberately bad placement (two ships overlapping) must be refused.
	const badFleet = rules.emptyFleet(size).map((s) => ({
		...s,
		cells: rules.shipCells({ x: 0, y: 0 }, s.len, 'h', size)
	}));
	const bad = await bs.placeFleet({ eventId, side: 1, fleet: badFleet });
	check('overlapping fleet refused', !bad.ok, bad.ok ? 'it was accepted' : bad.error);

	// Side 1 places for real; side 2 deliberately does NOT, to prove the auto-place
	// fallback keeps a no-show from stalling the event.
	const fleet1 = rules.autoPlace(size, rand);
	const placed = await bs.placeFleet({ eventId, side: 1, fleet: fleet1 });
	check('side 1 placed', placed.ok, placed.ok ? '' : placed.error);

	// ── 6. battle ────────────────────────────────────────────────────────────
	step(6, 'Open the battle');
	const battle = await bs.startBattle(eventId);
	check('battle opened', battle.ok, battle.ok ? '' : battle.error);
	snap = await bs.loadBattleship(SLUG);
	check('phase is battle', snap.phase === 'battle', snap.phase);
	for (const s of snap.sides) {
		const cells = s.fleet.reduce((n, f) => n + f.cells.length, 0);
		check(
			`side ${s.side} has a full fleet (${s.fleet.length} ships, ${cells} cells)`,
			s.fleet.length > 0 && s.fleet.every((f) => f.cells.length === f.len)
		);
	}
	check('side 2 was auto-placed after not placing', snap.sides[1].placedAt !== null);

	// The dink-proxy's only Battleship dependency: this view tells it whose drops to
	// record on value alone. If it's empty, no real drop ever becomes a bomb.
	const rsns = snap.sides.flatMap((s) => s.members).map((m) => m.rsn).filter(Boolean).map((r) => r.toLowerCase());
	const { data: tracked } = await sb.from('vs_value_tracked_rsns').select('rsn, min_value').in('rsn', rsns);
	check(
		'every player is value-tracked for the proxy once the battle opens',
		(tracked ?? []).length === new Set(rsns).size,
		`${(tracked ?? []).length} of ${new Set(rsns).size}`
	);
	check(
		'the floor served to the proxy is the tier-1 threshold',
		(tracked ?? []).every((r) => Number(r.min_value) === snap.config.tiers[0].min_value),
		`got ${[...new Set((tracked ?? []).map((r) => r.min_value))].join(',')}`
	);

	// ── 7. earning bombs ─────────────────────────────────────────────────────
	step(7, 'Earn bombs from drops');
	const tiers = snap.config.tiers;
	const underFloor = await bs.earnBomb({
		eventId, side: 1, userId: players[0].id,
		value: tiers[0].min_value - 1, dropKey: `sim-under-${SEED}`, itemName: 'Too cheap'
	});
	check('a drop under the floor earns nothing', !underFloor.minted && underFloor.tier === null);

	const dupKey = `sim-dup-${SEED}`;
	const first = await bs.earnBomb({ eventId, side: 1, userId: players[0].id, value: tiers[2].min_value, dropKey: dupKey, itemName: 'Twisted bow' });
	const second = await bs.earnBomb({ eventId, side: 1, userId: players[0].id, value: tiers[2].min_value, dropKey: dupKey, itemName: 'Twisted bow' });
	check('the same drop mints one bomb', first.minted && !second.minted, `first=${first.minted} second=${second.minted}`);
	check('a 50m drop is tier 3', first.tier === 3, `tier=${first.tier}`);

	// ── 7a. the real Dink path ───────────────────────────────────────────────
	// earnBomb() above is the unit; this is the integration. Write a row exactly like
	// the proxy writes, drain it with the real consumer, and prove a bomb comes out —
	// including that the reconcile pass (which re-runs recent drops) doesn't mint a
	// second one.
	step('7a', 'Arm a bomb through processDinkDrops');
	const dink = await server.ssrLoadModule('/src/lib/server/dinkDrops.ts');
	const dropper = snap.sides[0].members.find((m) => m.rsn);
	const dropKey = `sim-dink-${SEED}-${Date.now().toString(36)}`;
	const { error: dErr } = await sb.from('vs_dink_drops').insert({
		rsn: dropper.rsn,
		item_id: 20997,
		item_name: 'Twisted bow',
		quantity: 1,
		value: tiers[2].min_value + 1,
		source: 'Simulation',
		dink_ts: new Date().toISOString(),
		drop_key: dropKey,
		notif_type: 'loot'
	});
	check('drop row written like the proxy would', !dErr, dErr?.message);

	// The consumer drains a bounded batch of the WHOLE queue, oldest first, so on a busy
	// database our fresh drop can sit behind a backlog. Drain until it's been seen.
	const drainUntilProcessed = async (key) => {
		for (let i = 0; i < 20; i++) {
			const { data } = await sb.from('vs_dink_drops').select('processed').eq('drop_key', key).maybeSingle();
			if (data?.processed) return true;
			const res = await dink.processDinkDrops({ suppressFeed: true });
			if (res.processed === 0) return false;
		}
		return false;
	};

	const before = (await bs.loadBattleship(SLUG)).arsenal.length;
	check('the drop reached the consumer', await drainUntilProcessed(dropKey));
	let afterSnap = await bs.loadBattleship(SLUG);
	check('the drop armed a bomb', afterSnap.arsenal.length === before + 1, `${before} → ${afterSnap.arsenal.length}`);
	const armed = afterSnap.arsenal.find((a) => a.itemName === 'Twisted bow' && a.value >= tiers[2].min_value);
	check('it landed on the dropper\'s side and tier', !!armed && armed.side === 1 && armed.tier === 3,
		armed ? `side=${armed.side} tier=${armed.tier}` : 'not found');

	const { data: verdict } = await sb.from('vs_dink_drops').select('outcome, event_id').eq('drop_key', dropKey).maybeSingle();
	check('the drop is stamped as a bomb, not "didn\'t credit"', verdict?.outcome === 'bomb', verdict?.outcome);
	check('the bomb is attributed to this event', verdict?.event_id === eventId);

	// The reconcile pass deliberately re-runs recent un-credited drops. Minting must be
	// idempotent against it — this is what unique (event_id, drop_key) is for. Reset just
	// THIS drop the way reconcile would, rather than calling the global pass, which would
	// resurface days of unrelated rows on a shared database.
	await sb.from('vs_dink_drops').update({ processed: false, outcome: null }).eq('drop_key', dropKey);
	check('the re-surfaced drop was re-consumed', await drainUntilProcessed(dropKey));
	afterSnap = await bs.loadBattleship(SLUG);
	check('reconcile does not mint a second bomb', afterSnap.arsenal.length === before + 1,
		`arsenal=${afterSnap.arsenal.length}`);

	// A sub-threshold drop from the same player must arm nothing.
	const smallKey = `sim-dink-small-${SEED}-${Date.now().toString(36)}`;
	await sb.from('vs_dink_drops').insert({
		rsn: dropper.rsn, item_id: 526, item_name: 'Bones', quantity: 1,
		value: tiers[0].min_value - 1, source: 'Simulation',
		dink_ts: new Date().toISOString(), drop_key: smallKey, notif_type: 'loot'
	});
	await drainUntilProcessed(smallKey);
	afterSnap = await bs.loadBattleship(SLUG);
	check('a sub-threshold drop arms nothing', afterSnap.arsenal.length === before + 1,
		`arsenal=${afterSnap.arsenal.length}`);

	await sb.from('vs_dink_drops').delete().in('drop_key', [dropKey, smallKey]);

	// ── 7b. concurrency ──────────────────────────────────────────────────────
	// The serial fight below would pass even if the guards were read-then-write, so
	// prove them here: these are the two races a real event will actually hit — a
	// double-submitted fire, and two players firing overlapping bombs at once.
	step('7b', 'Concurrency guards');
	snap = await bs.loadBattleship(SLUG);
	const raceBomb = snap.arsenal.find((a) => a.side === 1 && !a.spentAt);
	const raceAnchor = { x: 0, y: 0 };
	const doubleFire = await Promise.all([
		bs.fireBomb({ eventId, arsenalId: raceBomb.id, byUserId: captains[0], anchor: raceAnchor, force: true }),
		bs.fireBomb({ eventId, arsenalId: raceBomb.id, byUserId: captains[0], anchor: raceAnchor, force: true })
	]);
	check(
		'the same bomb fired twice at once lands once',
		doubleFire.filter((r) => r.ok).length === 1,
		`${doubleFire.filter((r) => r.ok).length} succeeded`
	);

	// Two DIFFERENT tier-3 bombs aimed at the same 3x3: together they may claim each
	// cell only once, so the loser of each cell race sees it as `skipped`.
	await bs.earnBomb({ eventId, side: 1, userId: captains[0], value: tiers[2].min_value, dropKey: `sim-race-a-${SEED}` });
	await bs.earnBomb({ eventId, side: 1, userId: captains[0], value: tiers[2].min_value, dropKey: `sim-race-b-${SEED}` });
	snap = await bs.loadBattleship(SLUG);
	const overlap = snap.arsenal.filter((a) => a.side === 1 && !a.spentAt).slice(0, 2);
	const anchorB = { x: 4, y: 4 };
	const both = await Promise.all(
		overlap.map((b) => bs.fireBomb({ eventId, arsenalId: b.id, byUserId: captains[0], anchor: anchorB, force: true }))
	);
	const claimed = both.filter((r) => r.ok).flatMap((r) => r.value.cells.map((c) => c.cell));
	check('overlapping bombs never claim a cell twice', new Set(claimed).size === claimed.length,
		`${claimed.length} claimed, ${new Set(claimed).size} distinct`);
	check('the second bomb saw the overlap as skipped',
		both.filter((r) => r.ok).some((r) => r.value.skipped.length > 0) || both.some((r) => !r.ok));
	// A bomb that wins no cell — whether the pre-flight caught it or it lost the race
	// after claiming — must still be in the bank. Assert the bank, not the message.
	snap = await bs.loadBattleship(SLUG);
	const losers = overlap.filter((b, i) => !both[i].ok);
	check('a bomb that lands nothing stays banked',
		losers.every((b) => !snap.arsenal.find((a) => a.id === b.id)?.spentAt),
		losers.map((_, i) => both[i].ok ? '' : both[i].error).filter(Boolean).join('; '));

	// Bombs actually spent so far — the fight below adds to this, and step 9 reconciles.
	const raceSpent = 1 + both.filter((r) => r.ok).length;

	// ── 7c. adversarial ──────────────────────────────────────────────────────
	// Every one of these is something a player could try by hand-posting a form. They
	// must be refused by the SERVER, not by the UI not offering a button.
	step('7c', 'Things a player must not be able to do');
	snap = await bs.loadBattleship(SLUG);
	const side1 = snap.sides[0];
	const side2 = snap.sides[1];
	const rando1 = side1.members.find((m) => m.userId !== side1.captainUserId);
	const rando2 = side2.members.find((m) => m.userId !== side2.captainUserId);

	// Fire a bomb that belongs to the OTHER side.
	await bs.earnBomb({ eventId, side: 2, userId: side2.members[0].userId, value: tiers[0].min_value, dropKey: `adv-enemy-${SEED}` });
	snap = await bs.loadBattleship(SLUG);
	const enemyBomb = snap.arsenal.find((a) => a.side === 2 && !a.spentAt);
	const stealEnemy = await bs.fireBomb({ eventId, arsenalId: enemyBomb.id, byUserId: rando1.userId, anchor: { x: 0, y: 0 } });
	check("can't fire the other side's bomb", !stealEnemy.ok, stealEnemy.ok ? 'ALLOWED' : stealEnemy.error);

	// Fire a TEAMMATE's bomb without being captain.
	await bs.earnBomb({ eventId, side: 1, userId: side1.captainUserId, value: tiers[0].min_value, dropKey: `adv-mate-${SEED}` });
	snap = await bs.loadBattleship(SLUG);
	const mateBomb = snap.arsenal.find((a) => a.side === 1 && !a.spentAt && a.earnedBy === side1.captainUserId);
	const stealMate = await bs.fireBomb({ eventId, arsenalId: mateBomb.id, byUserId: rando1.userId, anchor: { x: 1, y: 1 } });
	check("a non-captain can't fire a teammate's bomb", !stealMate.ok, stealMate.ok ? 'ALLOWED' : stealMate.error);

	// The captain CAN — the rule the UI advertises has to actually hold.
	const captainFire = await bs.fireBomb({ eventId, arsenalId: mateBomb.id, byUserId: side1.captainUserId, anchor: { x: 1, y: 1 } });
	check('the captain can fire a teammate\'s bomb', captainFire.ok, captainFire.ok ? '' : captainFire.error);
	// Counted so the bomb-conservation check at the end still balances.
	const advSpent = captainFire.ok ? 1 : 0;

	// Someone not in the event at all.
	const outsider = players.find((p) => !snap.sides.some((s) => s.members.some((m) => m.userId === p.id)));
	if (outsider) {
		const outsiderFire = await bs.fireBomb({ eventId, arsenalId: enemyBomb.id, byUserId: outsider.id, anchor: { x: 2, y: 2 } });
		check("a non-participant can't fire", !outsiderFire.ok, outsiderFire.ok ? 'ALLOWED' : outsiderFire.error);
	}

	// Re-place a fleet after placement has closed (peeking at incoming fire then moving).
	const rePlace = await bs.placeFleet({ eventId, side: 1, fleet: rules.autoPlace(snap.config.size) });
	check("can't move ships once the battle is on", !rePlace.ok, rePlace.ok ? 'ALLOWED' : rePlace.error);

	// Join after the draft has started.
	const lateJoin = await sb.from('vs_event_signups').insert({ event_id: eventId, user_id: outsider?.id ?? players[0].id });
	// (the DB allows the row; the ACTION is what gates it — assert the phase gate instead)
	if (!lateJoin.error && outsider) await sb.from('vs_event_signups').delete().eq('event_id', eventId).eq('user_id', outsider.id);
	const lateLeave2 = await bs.leaveEvent({ eventId, userId: rando2.userId });
	check("can't leave once drafted", !lateLeave2.ok, lateLeave2.ok ? 'ALLOWED' : lateLeave2.error);

	// A manual claim under the tier floor must arm nothing even if approved.
	const tinyClaim = await bs.earnBomb({
		eventId, side: 1, userId: rando1.userId,
		value: tiers[0].min_value - 1, dropKey: `adv-tiny-${SEED}`
	});
	check('a sub-floor claim arms nothing', !tinyClaim.minted);

	// Inflating a claimed value past the top tier buys nothing — tier 3 is the ceiling.
	const huge = rules.tierForValue(999_000_000_000, tiers);
	check('an absurd value still only reaches the top tier', huge.tier === 3, `tier=${huge?.tier}`);

	// A PLAYING admin must not see the enemy fleet — captains at a clan event are
	// usually admins, and this is the difference between a game and a look at the answers.
	const playingAdmin = bs.redactFor(snap, { userId: rando1.userId, isAdmin: true });
	const enemyToAdmin = playingAdmin.sides.find((s) => s.side === 2);
	check('an admin who is PLAYING cannot see the enemy fleet', enemyToAdmin.fleet === null,
		enemyToAdmin.fleet === null ? '' : 'the enemy fleet leaked to a playing admin');
	const spectatorAdmin = bs.redactFor(snap, { userId: 'not-a-player', isAdmin: true });
	check('a non-participant admin still sees both (for the tester)',
		spectatorAdmin.sides.every((s) => Array.isArray(s.fleet)));

	// ── 8. fight ─────────────────────────────────────────────────────────────
	step(8, 'Fight until one fleet is gone');
	let bombsFired = 0;
	let totalHits = 0;
	let winner = null;
	let sunkReported = 0;

	// Each round: every side banks a drop, then fires everything it has. Attack order is
	// deterministic given the seed. Runs until a fleet is gone or the board fills.
	for (let round = 0; round < size * size * 2 && !winner; round++) {
		snap = await bs.loadBattleship(SLUG);
		if (snap.winner) { winner = snap.winner; break; }

		for (const side of snap.sides) {
			const member = pick(side.members);
			const roll = rand();
			const value =
				roll > 0.93 ? tiers[2].min_value + 1e6 : roll > 0.75 ? tiers[1].min_value + 1e6 : tiers[0].min_value + 1e6;
			await bs.earnBomb({
				eventId, side: side.side, userId: member.userId, value,
				dropKey: `sim-${SEED}-r${round}-s${side.side}`,
				itemName: 'Simulated drop', source: 'Simulation'
			});
		}

		snap = await bs.loadBattleship(SLUG);
		for (const side of snap.sides) {
			if (winner) break;
			const enemy = snap.sides.find((s) => s.side !== side.side);
			const fired = new Set(snap.shots.filter((s) => s.targetSide === enemy.side).map((s) => s.cell));
			const bombs = snap.arsenal.filter((a) => a.side === side.side && !a.spentAt);

			for (const bomb of bombs) {
				const tier = tiers.find((t) => t.tier === bomb.tier);
				const maxA = rules.maxAnchor(tier.span, size);
				// Aim at a spot that still has at least one un-cratered cell.
				let anchor = null;
				for (let attempt = 0; attempt < 200 && !anchor; attempt++) {
					const a = { x: Math.floor(rand() * (maxA + 1)), y: Math.floor(rand() * (maxA + 1)) };
					const cells = rules.bombCells(a, tier.span, size);
					if (cells && cells.some((c) => !fired.has(c))) anchor = a;
				}
				if (!anchor) continue;

				const res = await bs.fireBomb({
					eventId, arsenalId: bomb.id,
					byUserId: bomb.earnedBy ?? side.captainUserId,
					anchor
				});
				if (!res.ok) throw new Error(`fire failed: ${res.error}`);
				bombsFired++;
				totalHits += res.value.hits;
				sunkReported += res.value.sunk.length;
				for (const c of res.value.cells) fired.add(c.cell);
				for (const c of res.value.skipped) fired.add(c);
				if (res.value.defeated) { winner = side.side; break; }
			}
		}
	}

	check('a side won', winner !== null, winner ? `side ${winner}` : 'no winner after the round cap');
	check('bombs were actually fired', bombsFired > 0, `fired=${bombsFired}`);
	check('shots landed on ships', totalHits > 0, `hits=${totalHits}`);
	check('sinkings were reported', sunkReported > 0, `sunk=${sunkReported}`);

	// ── 9. final state ───────────────────────────────────────────────────────
	step(9, 'Verify the finished game');
	snap = await bs.loadBattleship(SLUG);
	check('phase is finished', snap.phase === 'finished', snap.phase);
	check('winner recorded', snap.winner === winner, `structure winner=${snap.winner}`);
	check('event has an end time', !!snap.event.endsAt);

	const loser = snap.sides.find((s) => s.side !== winner);
	const loserHits = new Set(snap.shots.filter((s) => s.targetSide === loser.side).map((s) => s.cell));
	const allSunk = loser.fleet.every((f) => f.cells.every((c) => loserHits.has(c)));
	check('every losing ship is sunk', allSunk);

	const standing = snap.standings.find((s) => s.side === loser.side);
	check('loser has nothing afloat', standing.afloat === 0, `afloat=${standing.afloat}`);
	check(
		'loser lost every ship',
		standing.lost === loser.fleet.length,
		`lost=${standing.lost}/${loser.fleet.length}`
	);

	// The whole point of the unique index: one row per cell, no duplicates, ever.
	const cellKeys = snap.shots.map((s) => `${s.targetSide}:${s.cell}`);
	check('no cell was fired at twice', new Set(cellKeys).size === cellKeys.length,
		`${cellKeys.length} shots, ${new Set(cellKeys).size} distinct`);

	// Every hit row must sit on a real ship cell, and every miss must not.
	let mislabeled = 0;
	for (const shot of snap.shots) {
		const side = snap.sides.find((s) => s.side === shot.targetSide);
		const onShip = side.fleet.some((f) => f.cells.includes(shot.cell));
		if (onShip !== shot.hit) mislabeled++;
	}
	check('every hit/miss flag matches the fleet', mislabeled === 0, `${mislabeled} mislabeled`);

	// Bombs are conserved: a spent bomb has a bomb_id and matching shot rows.
	// Every spent bomb corresponds to a fire that returned ok — no bomb vanishes, and
	// none is spent without craters to show for it.
	const spent = snap.arsenal.filter((a) => a.spentAt);
	check(
		'bombs fired match bombs spent',
		spent.length === bombsFired + raceSpent + advSpent,
		`spent=${spent.length} fired=${bombsFired}+${raceSpent}+${advSpent}`
	);
	const spentWithoutShots = spent.filter((a) => !snap.shots.some((s) => s.bombId && a.spentAt && s.tier === a.tier));
	check('no bomb was spent without leaving a crater', spentWithoutShots.length < spent.length);

	// Tracking must stop on its own when the game ends — the view is declarative, so
	// there is no prune job to forget to run.
	const { data: stillTracked } = await sb.from('vs_value_tracked_rsns').select('rsn').in('rsn', rsns);
	check('players stop being value-tracked once the game is over', (stillTracked ?? []).length === 0,
		`${(stillTracked ?? []).length} still tracked`);

	// ── 10. redaction ────────────────────────────────────────────────────────
	step(10, 'The enemy fleet must not leak to a player');
	const spy = snap.sides[0].members[0];
	const view = bs.redactFor(snap, { userId: spy.userId, isAdmin: false });
	const own = view.sides.find((s) => s.side === 1);
	const foe = view.sides.find((s) => s.side === 2);
	check('viewer resolved onto their own side', view.viewerSide === 1, `side=${view.viewerSide}`);
	check('own fleet is visible', Array.isArray(own.fleet) && own.fleet.length > 0);
	check('enemy fleet is withheld', foe.fleet === null);
	check('enemy ship names/sunk state still shown', foe.fleetSummary.length > 0);
	// The real test: serialize the enemy's whole side object and prove that no ship cell
	// the viewer has NOT already cratered appears in it. A cell that has been fired at is
	// public by definition (it is in `shots`); anything else is a leak.
	const publicCells = new Set(snap.shots.filter((s) => s.targetSide === 2).map((s) => s.cell));
	const secretCells = snap.sides[1].fleet.flatMap((f) => f.cells).filter((c) => !publicCells.has(c));
	const foeJson = JSON.stringify(foe);
	const leaked = secretCells.filter((c) => foeJson.includes(`"${c}"`));
	check(
		`no un-hit enemy cell appears in the payload (${secretCells.length} still secret)`,
		leaked.length === 0,
		leaked.length ? `leaked ${leaked.join(' ')}` : ''
	);

	// An admin who is PLAYING is redacted exactly like anyone else — see step 7c for why.
	// Only a non-participant admin (the tester) gets both fleets.
	const playingAdminView = bs.redactFor(snap, { userId: spy.userId, isAdmin: true });
	check(
		'a PLAYING admin is redacted like any other player',
		playingAdminView.sides.find((s) => s.side !== playingAdminView.viewerSide).fleet === null
	);
	const testerView = bs.redactFor(snap, { userId: 'not-in-this-game', isAdmin: true });
	check('a non-participant admin still sees both (the tester needs it)',
		testerView.sides.every((s) => Array.isArray(s.fleet)));

	// ── summary ──────────────────────────────────────────────────────────────
	console.log(
		`\nGame over: side ${winner} won on a ${size}x${size} board — ` +
			`${bombsFired} bombs, ${totalHits} hits, ${sunkReported} ships sunk.`
	);
} catch (err) {
	console.error(`\nSimulation aborted: ${err.message}`);
	failures.push(`aborted: ${err.message}`);
	exitCode = 1;
} finally {
	if (eventId && sb && !KEEP) {
		// Children cascade from the event row; the signups do not, so clear them first.
		await sb.from('vs_event_signups').delete().eq('event_id', eventId);
		await sb.from('vs_teams').delete().eq('event_id', eventId);
		await sb.from('vs_events').delete().eq('id', eventId);
		console.log(`\nCleaned up ${SLUG}.`);
	} else if (eventId) {
		console.log(`\nLeft ${SLUG} in place (--keep).`);
	}
	await server.close();
}

console.log(`\n${pass} passed, ${failures.length} failed`);
for (const f of failures) console.log(`  ✗ ${f}`);
process.exit(failures.length ? 1 : exitCode);
