// Regression harness for grouped clue-tile progress (docs/EVENTS.md § Personal tile kinds).
//
// Guards the bug where every hard/elite/master clue tile was unwinnable: progress used to be
// counted against `clue_candidates`, a list frozen at generation from itemEhc.json — whose
// hard tier holds 11 items that do not overlap AT ALL with what players actually pull from
// hard clues. Progress now comes from Temple's own category + date instead.
//
//   node scripts/clue-progress-check.mjs           # fixtures only (no network)
//   node scripts/clue-progress-check.mjs --live    # also replays real locked boards
//
// --live reads boards from the database and calls TempleOSRS; it asserts nothing (real
// logs change under us), it prints what each board WOULD score so a human can sanity-check.

import { createServer } from 'vite';

const LIVE = process.argv.includes('--live');

const server = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' });
const { clueGainsSince } = await server.ssrLoadModule('/src/lib/server/personalBoard.ts');

let failures = 0;
const check = (name, actual, expected) => {
	const ok = actual === expected;
	if (!ok) failures++;
	console.log(`  ${ok ? '✓' : '✗'} ${name}${ok ? '' : `  — got ${actual}, want ${expected}`}`);
};

// A Temple clog shaped exactly like the live endpoint: items grouped by category, each
// carrying "YYYY-MM-DD HH:MM:SS".
const clog = (byCat) => ({ items: byCat, finished: 0, available: 0 });
const item = (name, date, count = 1) => ({ id: 1, name, count, date });
const LOCK = '2026-07-01 00:00:00+00';

console.log('fixtures');

// The reported bug: five real hard uniques after the lock, none of them in our item pool.
check(
	'counts uniques obtained after the lock',
	clueGainsSince(
		clog({
			hard_treasure_trails: [
				item("Zamorak chaps", '2026-07-04 10:00:00'),
				item("Ancient d'hide body", '2026-07-05 10:00:00'),
				item('Rune full helm (t)', '2026-07-06 10:00:00'),
				item('Guthix kiteshield', '2026-07-07 10:00:00'),
				item('White cavalier', '2026-07-08 10:00:00')
			]
		}),
		LOCK
	).get('hard'),
	5
);

// Items owned BEFORE the lock are the player's back catalogue, not progress.
check(
	'ignores uniques obtained before the lock',
	clueGainsSince(
		clog({
			hard_treasure_trails: [
				item('Rune full helm (t)', '2026-06-01 10:00:00'),
				item('Guthix kiteshield', '2026-06-02 10:00:00'),
				item('White cavalier', '2026-07-09 10:00:00')
			]
		}),
		LOCK
	).get('hard'),
	1
);

// THE SAFETY CASE. For a slot obtained before the player's first Temple sync, `date` is the
// sync stamp — so a whole back catalogue shares one timestamp. Generating a board requires a
// Temple log, so that stamp always predates the lock and must score zero. If this ever fails,
// every long-standing player's clue tiles complete the instant they refresh.
check(
	'a pre-lock sync stamp on the whole catalogue scores zero',
	clueGainsSince(
		clog({
			hard_treasure_trails: Array.from({ length: 40 }, (_, i) =>
				item(`Item ${i}`, '2025-10-31 15:58:31')
			)
		}),
		LOCK
	).get('hard'),
	0
);

check(
	'tiers are counted separately',
	clueGainsSince(
		clog({
			hard_treasure_trails: [item('A', '2026-07-04 10:00:00')],
			elite_treasure_trails: [item('B', '2026-07-04 10:00:00'), item('C', '2026-07-05 10:00:00')]
		}),
		LOCK
	).get('elite'),
	2
);

// Shared rewards are obtainable from several tiers, so Temple files them outside the
// per-tier categories and they must not inflate any one tile.
check(
	'shared clue rewards count toward no tier',
	clueGainsSince(
		clog({ shared_treasure_trail_rewards: [item('Bandos page 1', '2026-07-04 10:00:00')] }),
		LOCK
	).get('hard') ?? 0,
	0
);

check(
	'an undated slot is treated as pre-existing',
	clueGainsSince(clog({ hard_treasure_trails: [item('A', null)] }), LOCK).get('hard'),
	0
);

check(
	'a slot the player does not own does not count',
	clueGainsSince(
		clog({ hard_treasure_trails: [item('A', '2026-07-04 10:00:00', 0)] }),
		LOCK
	).get('hard'),
	0
);

// Temple sends unix seconds on the values endpoint; the parser accepts both.
check(
	'accepts a unix-seconds date',
	clueGainsSince(
		clog({ hard_treasure_trails: [item('A', Math.floor(Date.parse('2026-07-04T10:00:00Z') / 1000))] }),
		LOCK
	).get('hard'),
	1
);

if (LIVE) {
	console.log('\nlive boards (informational — no assertions)');
	const { db } = await server.ssrLoadModule('/src/lib/server/db.ts');
	const { fetchTempleCollectionLog } = await server.ssrLoadModule('/src/lib/server/rankData.ts');

	// Start from the TILES, not the boards. Clue tiles are behind a sub-toggle, so most
	// boards have none — taking the newest boards and filtering found nothing at all.
	// Plain reads rather than embeds: an embed needs a foreign-key hint that varies by
	// schema and fails SILENTLY (empty rows, no error) when it is wrong.
	const { data: clueTiles, error: tileErr } = await db()
		.from('vs_tiles')
		.select('event_id, tile_key, meta')
		.eq('kind', 'clue')
		.limit(200);
	if (tileErr) console.log('  tile read failed:', tileErr.message);
	if (!clueTiles?.length) console.log('  no clue tiles found');

	const byBoard = new Map();
	for (const t of clueTiles ?? []) {
		if (!byBoard.has(t.event_id)) byBoard.set(t.event_id, []);
		byBoard.get(t.event_id).push(t);
	}

	const { data: boards } = await db()
		.from('vs_events')
		.select('id, locked_at, owner_user_id')
		.in('id', [...byBoard.keys()])
		.not('locked_at', 'is', null);
	const { data: users } = await db()
		.from('vs_users')
		.select('id, rsn')
		.in('id', [...new Set((boards ?? []).map((b) => b.owner_user_id).filter(Boolean))]);
	const rsnById = new Map((users ?? []).map((u) => [u.id, u.rsn]));

	for (const ev of (boards ?? []).slice(0, 12)) {
		const rsn = rsnById.get(ev.owner_user_id);
		if (!rsn) continue;
		const tiles = byBoard.get(ev.id) ?? [];

		const temple = await fetchTempleCollectionLog(rsn);
		if (!temple) { console.log(`  ${rsn}: no Temple record`); continue; }
		const gains = clueGainsSince(temple, ev.locked_at);
		for (const t of tiles) {
			const tier = t.meta?.clue_tier;
			const target = Number(t.meta?.clue_target ?? 0);
			const have = gains.get(tier) ?? 0;
			console.log(
				`  ${String(rsn).padEnd(16)} ${String(tier).padEnd(9)} ` +
					`stored=${String(t.meta?.clue_progress ?? 'null').padEnd(5)} ` +
					`now=${String(have).padStart(3)}/${target} ${have >= target ? '→ credits' : ''}`
			);
		}
		await new Promise((r) => setTimeout(r, 1200)); // be kind to Temple
	}
}

await server.close();
console.log(failures === 0 ? '\nall fixtures passed' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
