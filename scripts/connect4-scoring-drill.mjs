// The scoring table, asserted against what the event was designed to pay.
//
//   npm run drill:connect4:scoring
//
// Pure rules — no database, no game created. Guards the two things that are easy to
// break by touching pointsFor: the block rule past seven, and that a game stored
// before the mode existed still scores the old way.
import { createServer } from 'vite';

let pass = 0; const fail = [];
const ck = (l, got, want) => {
  if (got === want) { pass++; console.log(`  ✓ ${l} = ${got}`); }
  else { fail.push(`${l}: got ${got}, want ${want}`); console.log(`  ✗ ${l}: got ${got}, want ${want}`); }
};

const server = await createServer({ server: { middlewareMode: true }, logLevel: 'error', appType: 'custom' });
try {
  const r = await server.ssrLoadModule('/src/lib/connect4/rules.ts');
  const s = r.normalizeScoring(r.DEFAULT_SCORING);

  console.log('\n── The event table (10 a tile, complete fours past 7) ──');
  const line = (n) => r.pointsFor(n, s);
  // 4-7 keep their own tiers; 8 is two fours; 9-11 add nothing; 12 is three.
  for (const [len, want] of [[3,0],[4,40],[5,50],[6,60],[7,70],[8,80],[9,80],[10,80],[11,80],[12,120],[16,160]]) {
    ck(`run of ${String(len).padStart(2)} line pts`, line(len), want);
  }

  console.log('\n── With tiles, and what each tile was worth ──');
  const p = (col) => ({ id: `p${col}`, col, row: 0, side: 1, deck_idx: col, claimed_at: new Date().toISOString() });
  const total = (n) => r.sideStanding(Array.from({ length: n }, (_, i) => p(i)), 1, s).total;
  ck('4 in a row total', total(4), 80);
  ck('8 in a row total', total(8), 160);
  // Each is the tile's own 10 plus whatever it moves the line by.
  ck('the 4th tile is worth (10 + 40 line)', total(4) - total(3), 50);
  ck('the 8th tile is worth (10 + 10 line)', total(8) - total(7), 20);
  ck('the 9th tile is worth (10, line unmoved)', total(9) - total(8), 10);
  ck('the 12th tile is worth (10 + 40 line)', total(12) - total(11), 50);

  console.log('\n── One eight and two separate fours must agree ──');
  const split = [...Array.from({ length: 4 }, (_, i) => p(i)), ...Array.from({ length: 4 }, (_, i) => p(i + 10))];
  ck('two separate fours', r.sideStanding(split, 1, s).total, 160);

  console.log('\n── A game stored before the dial existed keeps the old rule ──');
  const legacy = r.normalizeScoring({
    tile_points: 10,
    line_points: [{ len: 4, points: 100 }, { len: 5, points: 250 }, { len: 6, points: 500 }, { len: 7, points: 900 }],
    extra_per_cell: 400,
    pet_points: 25
    // no line_mode — exactly what an older game's structure holds
  });
  ck("legacy mode reads as 'tiers'", legacy.line_mode, 'tiers');
  ck('legacy run of 8', r.pointsFor(8, legacy), 1300); // 900 + 1 × 400
  ck('legacy run of 4', r.pointsFor(4, legacy), 100);
} catch (e) { fail.push('threw: ' + e.message); console.error(e); }
finally { await server.close(); }

console.log(`\n${pass} passed, ${fail.length} failed`);
fail.forEach((f) => console.log('  ✗ ' + f));
process.exit(fail.length ? 1 : 0);
