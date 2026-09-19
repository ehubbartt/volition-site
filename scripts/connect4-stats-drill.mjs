// The post-event report, asserted against the board it describes.
//
//   npm run drill:connect4:stats
//
// Pure — no database, no game created. What it guards is the property that makes the
// report trustworthy: THE PLAYER LEADERBOARD ADDS UP TO THE SIDE TOTALS. The report sits
// directly under the final scoreboard, so a re-attribution that invented or lost points
// would contradict the numbers above it with no way to tell which half was wrong.
import { createServer } from 'vite';

let pass = 0;
const fail = [];
const ck = (l, got, want) => {
	const ok = typeof want === 'number' ? Math.abs(Number(got) - want) < 1e-9 : got === want;
	if (ok) { pass++; console.log(`  ✓ ${l} = ${JSON.stringify(got)}`); }
	else { fail.push(`${l}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); console.log(`  ✗ ${l}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
};

const server = await createServer({ server: { middlewareMode: true }, logLevel: 'error', appType: 'custom' });
try {
	const rules = await server.ssrLoadModule('/src/lib/connect4/rules.ts');
	const S = await server.ssrLoadModule('/src/lib/connect4/stats.ts');
	const scoring = rules.normalizeScoring(rules.DEFAULT_SCORING); // 10 a tile, 40 a four

	const ROWS = 15;
	const T0 = Date.parse('2026-09-12T10:00:00Z');
	const iso = (mins) => new Date(T0 + mins * 60_000).toISOString();
	// deck_idx must match col*ROWS+row so the "when did this tile go up" walk works.
	const piece = (col, row, side, by, mins) => ({
		id: `p${col}-${row}`, col, row, side, deck_idx: col * ROWS + row,
		by_user_id: by, item_name: `item-${col}-${row}`, claimed_at: iso(mins)
	});
	const base = (over = {}) => ({
		pieces: [], rows: ROWS, cells: 600, startsAt: iso(0), scoring,
		sides: [
			{ side: 1, name: 'Red', color: '#f00', members: [{ userId: 'a', rsn: 'Ayy' }, { userId: 'b', rsn: 'Bee' }] },
			{ side: 2, name: 'Yellow', color: '#ff0', members: [{ userId: 'z', rsn: 'Zed' }] }
		],
		bonus: [], shares: { 1: {}, 2: {} }, submissions: [],
		qtyOf: () => 1, nameOf: () => null, reviewerName: () => null, includeAdmin: false,
		...over
	});
	const whole = (u) => [{ userId: u, share: 1 }];
	const sum = (rows) => rows.reduce((t, p) => t + p.points, 0);
	const P = (st, u) => st.players.find((p) => p.userId === u) ?? { points: 0, tiles: 0, submissions: 0, approved: 0, rejected: 0, pets: 0 };

	console.log('\n── A solo claim is wholly its claimant\'s ──');
	{
		const st = S.computeStats(base({
			pieces: [piece(0, 0, 1, 'a', 5)],
			shares: { 1: { '0,0': whole('a') }, 2: {} }
		}));
		ck('Ayy points', P(st, 'a').points, 10);
		ck('Ayy tiles', P(st, 'a').tiles, 1);
		ck('claimed', st.board.claimed, 1);
		ck('THE INVARIANT — players sum to their side', sum(st.players.filter(p => p.side === 1)), st.sides[0].points);
	}

	console.log('\n── A four splits across the players who hold it ──');
	{
		const pieces = [0, 1, 2, 3].map((c) => piece(c, 0, 1, c < 2 ? 'a' : 'b', 10 + c));
		const shares = { 1: {}, 2: {} };
		pieces.forEach((p, i) => { shares[1][`${p.col},0`] = whole(i < 2 ? 'a' : 'b'); });
		const st = S.computeStats(base({ pieces, shares }));
		// 4 tiles x 10, plus a 40-point four split 10 a cell. Two cells each.
		ck('Ayy', P(st, 'a').points, 40);
		ck('Bee', P(st, 'b').points, 40);
		ck('side total', st.sides[0].points, 80);
		ck('THE INVARIANT', sum(st.players), st.sides[0].points);
		ck('longest line', st.records.longestLine.len, 4);
	}

	console.log('\n── A ×N tile splits by what each banked, twice over inside a line ──');
	{
		const pieces = [0, 1, 2, 3].map((c) => piece(c, 0, 1, 'a', 10 + c));
		const shares = { 1: {
			'0,0': [{ userId: 'a', share: 0.25 }, { userId: 'b', share: 0.75 }],
			'1,0': whole('a'), '2,0': whole('a'), '3,0': whole('a')
		}, 2: {} };
		const st = S.computeStats(base({ pieces, shares, qtyOf: (i) => (i === 0 ? 1000 : 1), nameOf: () => 'Big Grind' }));
		// Bee holds 3/4 of one cell of four: 7.5 of tiles and 7.5 of the line.
		ck('Bee', P(st, 'b').points, 15);
		ck('Ayy', P(st, 'a').points, 65);
		ck('THE INVARIANT', sum(st.players), st.sides[0].points);
		ck('biggest grind qty', st.records.biggestQty.qty, 1000);
		ck('biggest grind hands', st.records.biggestQty.contributors, 2);
		ck('most contested', st.records.mostContested.contributors, 2);
	}

	console.log('\n── An unattributable claim scores for the side, nobody\'s tally ──');
	{
		const st = S.computeStats(base({
			pieces: [piece(0, 0, 1, null, 5)],
			shares: { 1: { '0,0': [{ userId: null, share: 1 }] }, 2: {} }
		}));
		ck('side still has the tile', st.sides[0].points, 10);
		ck('no player row invented', st.players.length, 0);
	}

	console.log('\n── Pets land on the player who got them ──');
	{
		const st = S.computeStats(base({
			pieces: [piece(0, 0, 1, 'a', 5)],
			shares: { 1: { '0,0': whole('a') }, 2: {} },
			bonus: [
				{ side: 1, points: 10, byUserId: 'b' },
				{ side: 1, points: 10, byUserId: 'b' },
				{ side: 2, points: 10, byUserId: 'z' }
			]
		}));
		ck('Bee pets', P(st, 'b').pets, 2);
		ck('Bee points', P(st, 'b').points, 20);
		ck('total pets', st.board.pets, 3);
		ck('pet points', st.board.petPoints, 30);
		ck('side 1 pets', st.sides[0].pets, 2);
		ck('THE INVARIANT with pets', sum(st.players.filter(p => p.side === 1)), st.sides[0].points);
	}

	console.log('\n── The submission ledger ──');
	{
		const subs = [
			{ userId: 'a', status: 'approved', submittedAt: iso(1), reviewedAt: iso(5), reviewedBy: 'mod1' },
			{ userId: 'a', status: 'rejected', submittedAt: iso(2), reviewedAt: iso(12), reviewedBy: 'mod1' },
			{ userId: 'b', status: 'approved', submittedAt: iso(3), reviewedAt: iso(9), reviewedBy: 'mod2' },
			{ userId: 'b', status: 'pending', submittedAt: iso(4), reviewedAt: null, reviewedBy: null },
			{ userId: 'z', status: 'approved', submittedAt: iso(5), reviewedAt: iso(6), reviewedBy: 'mod1' }
		];
		const st = S.computeStats(base({ submissions: subs }));
		ck('total', st.submissions.total, 5);
		ck('approved', st.submissions.approved, 3);
		ck('rejected', st.submissions.rejected, 1);
		ck('pending', st.submissions.pending, 1);
		ck('Ayy sent', P(st, 'a').submissions, 2);
		ck('Ayy rejected', P(st, 'a').rejected, 1);
		ck('side 1 turned up', st.sides[0].active, 2);
		ck('side 2 turned up', st.sides[1].active, 1);
		ck('no review desk for a member', st.admin, null);

		const adm = S.computeStats(base({
			submissions: subs,
			includeAdmin: true,
			reviewerName: (id) => ({ mod1: 'Modd', mod2: 'Tooo' })[id] ?? null
		}));
		ck('reviewers', adm.admin.reviewers.length, 2);
		ck('busiest reviewer', adm.admin.reviewers[0].rsn, 'Modd');
		ck('their decisions', adm.admin.reviewers[0].total, 3);
		ck('their approvals', adm.admin.reviewers[0].approved, 2);
		// mod1 waits: 4, 10, 1 -> median 4.
		ck('their median wait', adm.admin.reviewers[0].medianMinutes, 4);
		// all waits: 4, 10, 6, 1 -> median (4+6)/2 = 5.
		ck('overall median wait', adm.admin.medianReviewMinutes, 5);
		ck('left in the queue', adm.admin.unreviewed, 1);
		// a: 2 sent 1 approved -> 1; b: 2 sent 1 approved -> 1; z: 1/1 -> 0.
		ck('extra attempts', adm.admin.resubmitted, 2);
	}

	console.log('\n── How long each tile stood, and when the board moved ──');
	{
		// Column 0: bottom slot goes up at the start and is taken at +30. The slot above
		// it only goes up THEN, and is taken at +45 — so it stood 15, not 45.
		const pieces = [piece(0, 0, 1, 'a', 30), piece(0, 1, 1, 'b', 45), piece(1, 0, 2, 'z', 200)];
		const st = S.computeStats(base({
			pieces,
			shares: { 1: { '0,0': whole('a'), '0,1': whole('b') }, 2: { '1,0': whole('z') } }
		}));
		ck('fastest stood', st.records.fastestClaim.minutes, 15);
		ck('fastest was', st.records.fastestClaim.rsn, 'Bee');
		ck('slowest stood', st.records.slowestClaim.minutes, 200);
		// 15, 30, 200 -> median 30
		ck('median tile life', st.records.medianClaimMinutes, 30);
		// +30 and +45 fall in the SAME hour bucket, +200 in another: two buckets, peak 2.
		ck('hours with claims', st.timeline.length, 2);
		ck('busiest hour count', st.records.busiestHour.claims, 2);
		ck('busiest hour is the first', st.records.busiestHour.hour, '2026-09-12T10:00:00Z');
		ck('window opens', st.window.first, iso(30));
		ck('window closes', st.window.last, iso(200));
	}

	console.log('\n── A claim stamped before its tile went up is not a record ──');
	{
		// A hand-fixed row: the piece above claims EARLIER than the one below it.
		const pieces = [piece(0, 0, 1, 'a', 60), piece(0, 1, 1, 'b', 20)];
		const st = S.computeStats(base({
			pieces, shares: { 1: { '0,0': whole('a'), '0,1': whole('b') }, 2: {} }
		}));
		ck('only the sane one counts', st.records.fastestClaim.minutes, 60);
		ck('still both on the board', st.board.claimed, 2);
	}

	console.log('\n── Median ──');
	{
		ck('empty', S.median([]), null);
		ck('odd', S.median([5, 1, 3]), 3);
		ck('even', S.median([4, 1, 3, 2]), 2.5);
	}
} finally {
	await server.close();
}

console.log(`\n${pass} passed, ${fail.length} failed`);
if (fail.length) { for (const f of fail) console.log(`  ✗ ${f}`); process.exit(1); }
