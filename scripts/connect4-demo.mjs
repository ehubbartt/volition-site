// Leave a playable Connect Four game behind, for clicking through by hand. The
// simulation cleans up after itself, which is the opposite of what you want when you're
// testing the UI.
//
//   npm run demo:connect4                          # a live board with pieces on it
//   npm run demo:connect4 -- --phase setup         # stop before the deal, to curate
//   npm run demo:connect4 -- --pieces 120          # a fuller board
//   npm run demo:connect4 -- --delete              # remove it again
//
// Flags:
//   --players N   members to split across the two sides (default 40)
//   --pieces N    claims to play out (default 70)
//   --phase P     setup | live  (default live)
//   --slug S      the slug to use (default test-connect4)
//   --seed N      seed the deal and the play-out
//   --delete      delete the game and exit
//
// Run it against STAGING. It leaves a `test` + `unlisted` event behind, and re-running
// REPLACES it, so it doubles as a reset. It refuses to delete an event not marked as a
// test. The pool is filled with REAL roster members as stand-ins — inventing vs_users
// rows would land in the member counts and rank tables the home page builds from that
// table. Safe on staging, which takes no live Dink traffic; don't point it at one that does.

import { createServer } from 'vite';

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
	const i = argv.indexOf(`--${name}`);
	return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
};
const has = (name) => argv.includes(`--${name}`);

const PLAYERS = Number(flag('players', 40));
const PIECES = Number(flag('pieces', 70));
const PHASE = flag('phase', 'live');
const SLUG = flag('slug', 'test-connect4');
const SEED = Number(flag('seed', 8080));
const DELETE = has('delete');

let seed = SEED >>> 0 || 1;
const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);

const server = await createServer({ server: { middlewareMode: true }, logLevel: 'error', appType: 'custom' });
let exitCode = 0;

try {
	const c4 = await server.ssrLoadModule('/src/lib/server/connect4.ts');
	const pool = await server.ssrLoadModule('/src/lib/server/connect4Pool.ts');
	const rules = await server.ssrLoadModule('/src/lib/connect4/rules.ts');
	const { db } = await server.ssrLoadModule('/src/lib/server/db.ts');
	const sb = db();

	const existing = await c4.loadConnect4(SLUG);

	if (DELETE) {
		if (!existing) {
			console.log(`Nothing at ${SLUG}.`);
		} else {
			const res = await c4.deleteConnect4(existing.id);
			console.log(res.ok ? `Deleted ${SLUG}.` : `Refused: ${res.error}`);
			if (!res.ok) exitCode = 1;
		}
	} else {
		// Re-running replaces the game, so this doubles as a reset.
		if (existing) {
			const res = await c4.deleteConnect4(existing.id);
			if (!res.ok) throw new Error(`could not replace the existing game: ${res.error}`);
			console.log(`Replaced the previous ${SLUG}.`);
		}

		const { data: users } = await sb
			.from('vs_users')
			.select('id, rsn')
			.not('rsn', 'is', null)
			.limit(Math.max(PLAYERS, 8));
		const roster = (users ?? []).filter((u) => u.rsn);
		if (roster.length < 4) throw new Error('not enough members on the roster');
		const players = roster.slice(0, PLAYERS);

		const created = await c4.createConnect4({
			slug: SLUG,
			name: 'Connect Four — test game',
			description: 'Left behind by npm run demo:connect4. Safe to delete.',
			ownerUserId: players[0].id,
			sideNames: ['Volition', 'Challengers'],
			test: true
		});
		if (!created.ok) throw new Error(created.error);
		const eventId = created.value.id;
		console.log(`Created ${SLUG}.`);

		const candidates = await pool.poolCandidates();
		const picked = pool.autoSelect(candidates, rules.DECK_SIZE);
		const setRes = await c4.setPool(eventId, pool.toTileRefs(picked));
		if (!setRes.ok) throw new Error(setRes.error);
		console.log(`Curated ${rules.DECK_SIZE} tiles.`);

		const half = Math.ceil(players.length / 2);
		await c4.enrolMembers({ eventId, userIds: players.slice(0, half).map((p) => p.id), side: 1 });
		await c4.enrolMembers({ eventId, userIds: players.slice(half).map((p) => p.id), side: 2 });
		console.log(`Put ${players.length} members on two sides.`);

		if (PHASE === 'setup') {
			console.log(`\nLeft at setup: /admin/connect4/${SLUG}`);
		} else {
			const started = await c4.startGame(eventId, SEED);
			if (!started.ok) throw new Error(started.error);
			console.log(`Dealt the deck (seed ${started.value.seed}).`);

			// Play out claims with a bias towards clustering, so the board actually grows
			// lines to look at rather than a uniform scatter that never connects anything.
			let placed = 0;
			let lastCol = Math.floor(rand() * rules.COLS);
			for (let i = 0; i < PIECES; i++) {
				const snap = await c4.loadConnect4(SLUG);
				const open = snap.live.filter(Boolean);
				if (!open.length) break;
				const near = open.filter((l) => Math.abs(l.col - lastCol) <= 2);
				// Decide the list ONCE — drawing it and its length from separate rolls can
				// index the short list with the long list's length and pick nothing.
				const from = rand() < 0.65 && near.length ? near : open;
				const choice = from[Math.floor(rand() * from.length)];
				if (!choice) continue;
				const side = rand() < 0.5 ? 1 : 2;
				const who = side === 1 ? players[Math.floor(rand() * half)] : players[half + Math.floor(rand() * (players.length - half))];
				const res = await c4.claimTile({
					eventId,
					side,
					col: choice.col,
					dropKey: `test-demo-${SEED}-${i}`,
					byUserId: who?.id ?? null
				});
				if (res.status === 'claimed') {
					placed++;
					lastCol = choice.col;
				}
			}
			const snap = await c4.loadConnect4(SLUG);
			const [s1, s2] = snap.standings;
			console.log(`Played ${placed} claims.`);
			console.log(
				`  ${snap.sides[0].name}: ${s1.total} (${s1.tiles} tiles, longest ${s1.longest})\n` +
					`  ${snap.sides[1].name}: ${s2.total} (${s2.tiles} tiles, longest ${s2.longest})`
			);
			console.log(`\nReady: /admin/connect4/${SLUG}`);
		}
	}
} catch (err) {
	console.error(`✗ ${err.message}`);
	exitCode = 1;
} finally {
	await server.close();
}
process.exit(exitCode);
