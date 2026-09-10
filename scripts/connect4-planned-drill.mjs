// The PLANNED BOARD, end to end: that the checked-in list is the board the event was
// designed with, that it still equals a fresh import of the sheet, and that it deals.
//
//   npm run drill:connect4:planned [path/to/sheet-export.csv]
//
// Creates one unlisted TEST game and deletes it again.
import { createServer } from 'vite';
import { readFileSync, existsSync } from 'node:fs';
const SLUG = `planned-${Date.now().toString(36)}`;
let pass = 0; const fail = [];
const ck = (l, c, d) => { if (c) { pass++; console.log(`  ✓ ${l}`); } else { fail.push(l); console.log(`  ✗ ${l}${d ? ` — ${d}` : ''}`); } };
const s = await createServer({ server: { middlewareMode: true }, logLevel: 'error', appType: 'custom' });
let eventId = null, c4 = null;
try {
  c4 = await s.ssrLoadModule('/src/lib/server/connect4.ts');
  const imp = await s.ssrLoadModule('/src/lib/server/connect4Import.ts');
  const { db } = await s.ssrLoadModule('/src/lib/server/db.ts');
  const sb = db();

  const planned = imp.plannedTiles();
  ck('built-in list is 244 tiles', planned.length === 244, `${planned.length}`);
  ck('summary says 244 / 600', imp.PLANNED_SUMMARY.tiles === 244 && imp.PLANNED_SUMMARY.cells === 600);
  const { custom, pool } = imp.toPoolAndCustom(planned);
  ck('expands to exactly 600 cells', pool.length === 600, `${pool.length}`);
  ck('every tile has a name', planned.every((t) => t.name && t.name.trim()));
  ck('no summary rows leaked in', !planned.some((t) => /^total /i.test(t.name)));
  ck('tier split is 150 / 300 / 150 cells', JSON.stringify(planned.reduce((a, t) => { a[t.tier] = (a[t.tier] ?? 0) + t.copies; return a; }, {})) === '{"Low":150,"Medium":300,"High":150}');
  ck('107 tiles need more than one drop', planned.filter((t) => t.qty > 1).length === 107);

  // The built-in list must equal what importing the sheet export produces — that is
  // the whole claim the button makes. Skipped when no export is on hand.
  const sheet = process.argv[2] ?? 'e2e-shots/connect4-tiles.csv';
  if (existsSync(sheet)) {
    const viaCsv = imp.parseTileCsv(readFileSync(sheet, 'utf8'));
    // Compared as a SET: the sheet is read row by row across the three tier blocks,
    // while an older export ran tier by tier. Order is not part of the claim — the
    // deck is shuffled at deal time — but every tile and its numbers are.
    const key = (list) => JSON.stringify(list.map((t) => `${t.name}|${t.qty}|${t.copies}`).sort());
    ck(`same tiles as a fresh import of ${sheet}`,
      key(viaCsv.tiles) === key(planned), `${viaCsv.tiles.length} vs ${planned.length}`);
  } else console.log(`  ⏸  no sheet export at ${sheet} — skipping the round-trip check`);

  const { data: users } = await sb.from('vs_users').select('id, rsn').not('rsn', 'is', null).limit(2);
  const [a, b] = users ?? [];
  const created = await c4.createConnect4({ slug: SLUG, name: 'Planned board drill', ownerUserId: a.id, test: true });
  if (!created.ok) throw new Error(created.error);
  eventId = created.value.id;
  const game = await c4.loadConnect4(SLUG);
  ck('a default game is 600 cells', game.deckSize === 600, `${game.deckSize}`);

  const res = await c4.importPool(eventId, custom, pool);
  ck('the planned board loads into the game', res.ok, res.ok ? '' : res.error);

  await c4.enrolMembers({ eventId, userIds: [a.id], side: 1 });
  await c4.enrolMembers({ eventId, userIds: [b.id], side: 2 });
  const started = await c4.startGame(eventId);
  ck('the game starts', started.ok, started.ok ? '' : started.error);
  const snap = await c4.loadConnect4(SLUG);
  ck('deck dealt 600', snap.deck.length === 600, `${snap.deck.length}`);
  ck('40 live tiles', snap.live.filter(Boolean).length === 40);
  const names = new Set(snap.deck.map((t) => t.item_name));
  ck('all 244 distinct tiles are on the board', names.size === 244, `${names.size}`);
  const qtyOnBoard = snap.deck.filter((t) => t.qty && t.qty > 1).length;
  ck('quantity tiles survived the deal', qtyOnBoard > 0, `${qtyOnBoard} cells`);
  ck('the group tile kept its members', snap.deck.some((t) => t.any_of && t.any_of.length === 5));
} catch (e) { fail.push('threw: ' + e.message); console.error(e); }
finally { if (eventId && c4) await c4.deleteConnect4(eventId).catch(() => {}); await s.close(); }
console.log(`\n${pass} passed, ${fail.length} failed`);
fail.forEach((f) => console.log('  ✗ ' + f));
process.exit(fail.length ? 1 : 0);
