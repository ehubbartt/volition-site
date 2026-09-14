// Internal teams (squads), asserted against the board they re-read.
//
//   npm run drill:connect4:squads
//
// Pure — no database, no game created. What it guards is the one property that makes a
// squad table trustworthy: THE SQUADS' TOTALS ADD BACK UP TO THE SIDE'S OWN TOTAL. A
// re-attribution that invents or loses points would show the clan an internal race that
// does not match the scoreboard sitting directly above it, and nobody could tell which
// number was wrong.
import { createServer } from 'vite';

let pass = 0;
const fail = [];
const ck = (l, got, want) => {
	const ok = Math.abs(Number(got) - Number(want)) < 1e-9;
	if (ok) { pass++; console.log(`  ✓ ${l} = ${got}`); }
	else { fail.push(`${l}: got ${got}, want ${want}`); console.log(`  ✗ ${l}: got ${got}, want ${want}`); }
};
const ckStr = (l, got, want) => {
	if (got === want) { pass++; console.log(`  ✓ ${l}`); }
	else { fail.push(`${l}: got ${got}, want ${want}`); console.log(`  ✗ ${l}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
};

const server = await createServer({ server: { middlewareMode: true }, logLevel: 'error', appType: 'custom' });
try {
	const rules = await server.ssrLoadModule('/src/lib/connect4/rules.ts');
	const sq = await server.ssrLoadModule('/src/lib/connect4/squads.ts');
	const scoring = rules.normalizeScoring(rules.DEFAULT_SCORING); // 10 a tile, 40 a four

	// Side 1 is the squad side; side 2 is the other clan and must never be attributed.
	const piece = (col, row, side, deckIdx = col * 15 + row) => ({
		id: `p${col}-${row}`, col, row, side, deck_idx: deckIdx
	});
	const view = (cells, members = {}) => ({
		side: 1,
		squads: sq.squadDefs(['red', 'blue', 'yellow']),
		cells,
		members,
		viewerSquad: null
	});
	const rowOf = (rows, key) => rows.find((r) => r.key === key) ?? { total: 0, tiles: 0, bonusPoints: 0 };
	const sum = (rows) => rows.reduce((a, r) => a + r.total, 0);

	console.log('\n── A ×1 tile is wholly its claimant\'s ──');
	{
		const pieces = [piece(0, 0, 1)];
		const rows = sq.squadStandings(view({ '0,0': [{ key: 'red', share: 1 }] }), [], scoring, [], pieces);
		ck('red total', rowOf(rows, 'red').total, 10);
		ck('red tiles', rowOf(rows, 'red').tiles, 1);
		ck('blue total', rowOf(rows, 'blue').total, 0);
		ck('blue still has a row', rows.filter((r) => r.key === 'blue').length, 1);
	}

	console.log('\n── A ×N tile splits by what each squad banked ──');
	{
		const pieces = [piece(0, 0, 1)];
		// 750 / 250 of a 1,000 tile: three quarters and one quarter, not one and nothing.
		const rows = sq.squadStandings(
			view({ '0,0': [{ key: 'red', share: 0.75 }, { key: 'blue', share: 0.25 }] }),
			[], scoring, [], pieces
		);
		ck('red points', rowOf(rows, 'red').total, 7.5);
		ck('blue points', rowOf(rows, 'blue').total, 2.5);
		ck('red tiles', rowOf(rows, 'red').tiles, 0.75);
		ck('the tile is still worth one tile', rowOf(rows, 'red').tiles + rowOf(rows, 'blue').tiles, 1);
	}

	console.log('\n── A four splits across the squads holding its cells ──');
	{
		const pieces = [0, 1, 2, 3].map((c) => piece(c, 0, 1));
		const runs = rules.findRuns(pieces, 4);
		ck('one run found', runs.length, 1);
		const cells = {
			'0,0': [{ key: 'red', share: 1 }],
			'1,0': [{ key: 'red', share: 1 }],
			'2,0': [{ key: 'blue', share: 1 }],
			'3,0': [{ key: 'yellow', share: 1 }]
		};
		const rows = sq.squadStandings(view(cells), runs, scoring, [], pieces);
		// The four pays 40: 10 a cell. Red holds two cells, so 20 of the line plus 20 of tiles.
		ck('red', rowOf(rows, 'red').total, 40);
		ck('blue', rowOf(rows, 'blue').total, 20);
		ck('yellow', rowOf(rows, 'yellow').total, 20);
		const side = rules.sideStanding(pieces, 1, scoring);
		ck('THE INVARIANT — squads sum to the side total', sum(rows), side.total);
	}

	console.log('\n── A mixed ×N cell inside a line splits twice over ──');
	{
		const pieces = [0, 1, 2, 3].map((c) => piece(c, 0, 1));
		const runs = rules.findRuns(pieces, 4);
		const cells = {
			'0,0': [{ key: 'red', share: 0.5 }, { key: 'blue', share: 0.5 }],
			'1,0': [{ key: 'red', share: 1 }],
			'2,0': [{ key: 'red', share: 1 }],
			'3,0': [{ key: 'red', share: 1 }]
		};
		const rows = sq.squadStandings(view(cells), runs, scoring, [], pieces);
		// Blue owns half of one cell out of four: half a tile (5) and half that cell's
		// tenth of the line (5).
		ck('blue', rowOf(rows, 'blue').total, 10);
		ck('red', rowOf(rows, 'red').total, 70);
		ck('THE INVARIANT', sum(rows), rules.sideStanding(pieces, 1, scoring).total);
	}

	console.log('\n── The other clan is never attributed ──');
	{
		const pieces = [piece(0, 0, 1), piece(5, 0, 2), piece(6, 0, 2)];
		const cells = { '0,0': [{ key: 'red', share: 1 }], '5,0': [{ key: 'blue', share: 1 }] };
		const rows = sq.squadStandings(view(cells), [], scoring, [], pieces);
		ck('only the squad side counts', sum(rows), 10);
		ck('blue got nothing from side 2', rowOf(rows, 'blue').total, 0);
	}

	console.log('\n── Nobody\'s claim lands in the unassigned bucket, not on the floor ──');
	{
		const pieces = [piece(0, 0, 1), piece(1, 0, 1)];
		// Second cell has no shares at all — a hand-credited piece with no claimant.
		const rows = sq.squadStandings(view({ '0,0': [{ key: 'red', share: 1 }] }), [], scoring, [], pieces);
		ck('unassigned picked it up', rowOf(rows, sq.UNASSIGNED).total, 10);
		ck('THE INVARIANT', sum(rows), rules.sideStanding(pieces, 1, scoring).total);
	}

	console.log('\n── A pet goes whole to its winner\'s squad ──');
	{
		const pieces = [piece(0, 0, 1)];
		const members = { u1: 'blue', u2: 'red' };
		const bonus = [
			{ side: 1, points: 10, byUserId: 'u1' },
			{ side: 2, points: 10, byUserId: 'u2' }, // the other clan's pet
			{ side: 1, points: 10, byUserId: null } // an award with no name on it
		];
		const rows = sq.squadStandings(
			view({ '0,0': [{ key: 'red', share: 1 }] }, members), [], scoring, bonus, pieces
		);
		ck('blue banked the pet', rowOf(rows, 'blue').bonusPoints, 10);
		// The count and the points are DIFFERENT NUMBERS. pet_points is 10, so reading the
		// points as a count showed a team with five pets as having fifty.
		ck('blue banked ONE pet, not ten', rowOf(rows, 'blue').bonusCount, 1);
		ck("side 2's pet was ignored", rowOf(rows, 'red').bonusPoints, 0);
		ck('the nameless award went to unassigned', rowOf(rows, sq.UNASSIGNED).bonusPoints, 10);
		ck('and counts as one award', rowOf(rows, sq.UNASSIGNED).bonusCount, 1);
		ck("side 2's pet is not counted either", rowOf(rows, 'red').bonusCount, 0);
		const side = rules.sideStanding(pieces, 1, scoring, { 1: 20 });
		ck('THE INVARIANT, with bonuses', sum(rows), side.total);
	}

	console.log('\n── Five pets are five pets, not fifty ──');
	{
		const members = { u1: 'red', u2: 'red', u3: 'blue' };
		const bonus = [
			...Array.from({ length: 5 }, (_, i) => ({ side: 1, points: 10, byUserId: i < 4 ? 'u1' : 'u2' })),
			{ side: 1, points: 25, byUserId: 'u3' } // a hand-tuned award, still one pet
		];
		const rows = sq.squadStandings(view({}, members), [], scoring, bonus, []);
		ck('red pet count', rowOf(rows, 'red').bonusCount, 5);
		ck('red pet points', rowOf(rows, 'red').bonusPoints, 50);
		ck('blue pet count', rowOf(rows, 'blue').bonusCount, 1);
		ck('blue pet points', rowOf(rows, 'blue').bonusPoints, 25);
	}

	console.log('\n── Roster counts, and who is on no squad ──');
	{
		const members = { a: 'red', b: 'red', c: 'blue', d: sq.UNASSIGNED };
		const rows = sq.squadStandings(view({}, members), [], scoring, [], []);
		ck('red players', rowOf(rows, 'red').members, 2);
		ck('blue players', rowOf(rows, 'blue').members, 1);
		ck('yellow players', rowOf(rows, 'yellow').members, 0);
		// The unassigned player has scored nothing, so the bucket stays off the table.
		ck('empty unassigned bucket is hidden', rows.filter((r) => r.key === sq.UNASSIGNED).length, 0);
	}

	console.log('\n── Playback: only the pieces on show are counted ──');
	{
		const all = [0, 1, 2, 3].map((c) => piece(c, 0, 1));
		const cells = Object.fromEntries(all.map((p) => [`${p.col},0`, [{ key: 'red', share: 1 }]]));
		const half = sq.squadStandings(view(cells), rules.findRuns(all, 4), scoring, [], all.slice(0, 2));
		ck('two discs in, two tiles scored', rowOf(half, 'red').total, 20);
		const whole = sq.squadStandings(view(cells), rules.findRuns(all, 4), scoring, [], all);
		ck('four discs in, the line pays', rowOf(whole, 'red').total, 80);
	}

	console.log('\n── The ring is drawn in proportion ──');
	{
		const color = (k) => ({ red: '#f00', blue: '#00f' })[k] ?? '#888';
		ckStr('a solo cell is one full sweep',
			sq.ringStops([{ key: 'red', share: 1 }], color), '#f00 0.00deg 360.00deg');
		ckStr('a 75/25 cell sweeps 270 then 90',
			sq.ringStops([{ key: 'blue', share: 0.25 }, { key: 'red', share: 0.75 }], color),
			'#f00 0.00deg 270.00deg, #00f 270.00deg 360.00deg');
		ckStr('no shares, no ring', sq.ringStops(undefined, color), null);
	}

	console.log('\n── An unknown squad key still gets a name and a colour ──');
	{
		const [d] = sq.squadDefs(['green team']);
		ckStr('label', d.name, 'Green Team');
		ck('it has a colour', d.color.length, 7);
	}
} finally {
	await server.close();
}

console.log(`\n${pass} passed, ${fail.length} failed`);
if (fail.length) { for (const f of fail) console.log(`  ✗ ${f}`); process.exit(1); }
