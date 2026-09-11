// What a REJECTION has to undo, and what a second claim must not do.
//
//   npm run drill:connect4:reject
//
// Calls the real form actions — the member's submitClaim and the admin queue's decide —
// against the QA lab board, so it covers the wiring and not just the functions under it.
// No browser: both bugs it guards live in the actions, and a headless journey to reach
// them is slower and flakier than posting the forms.
//
// The two regressions it exists for:
//   1. a full rejection used to leave a quantity tile's bank standing, so the side's next
//      drop finished the tile off the back of a claim an admin had thrown out — and a
//      partial-cover claim places no piece, so the rejection did nothing at all;
//   2. an ordinary SECOND claim in a column whose first claim was still unreviewed was
//      read as a resubmit: it stole the first claim's proof and placed nothing.
//
// Both are proven by reverting the fix and watching this go red — 7 of its 13 checks fail.
import { createServer } from 'vite';

const SLUG = process.env.C4_QA_SLUG ?? 'c4-verify';
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);
const proof = () => new File([PNG], 'proof.png', { type: 'image/png' });

const server = await createServer({ server: { middlewareMode: true }, logLevel: 'error', appType: 'custom' });
const ok = [], bad = [];
const check = (cond, msg) => (cond ? ok : bad).push(msg);

try {
  const c4 = await server.ssrLoadModule('/src/lib/server/connect4.ts');
  const { db } = await server.ssrLoadModule('/src/lib/server/db.ts');
  const member = await server.ssrLoadModule('/src/routes/events/[slug]/connect4/+page.server.ts');
  const admin = await server.ssrLoadModule('/src/routes/admin/submissions/+page.server.ts');
  const sb = db();

  const game = await c4.loadConnect4(SLUG);
  const users = async (discordIds) => {
    const { data } = await sb.from('vs_users').select('id, discord_id, rsn').in('discord_id', discordIds);
    return data ?? [];
  };
  const cast = await users([
    '662917663361859631', '337749760016515073',
    (process.env.SUPER_ADMIN_DISCORD_IDS ?? '').split(',')[0].trim()
  ]);
  const red1 = cast.find((u) => u.discord_id === '662917663361859631');
  const red2 = cast.find((u) => u.discord_id === '337749760016515073');
  const adminUser = cast.find((u) => u.discord_id !== red1.discord_id && u.discord_id !== red2.discord_id);
  if (!adminUser) throw new Error('no admin account on this database');

  const submit = async (user, col, { quantity = 1, resubmit = false } = {}) => {
    const fd = new FormData();
    fd.set('col', String(col));
    fd.set('quantity', String(quantity));
    if (resubmit) fd.set('resubmit', '1');
    fd.append('proof', proof());
    const req = new Request(`http://local/events/${SLUG}/connect4?/submitClaim`, { method: 'POST', body: fd });
    return member.actions.submitClaim({ request: req, locals: { user }, params: { slug: SLUG } });
  };
  const bankFor = async (deckIdx, side) => {
    const { data } = await sb.from('vs_connect4_progress').select('qty')
      .eq('event_id', game.id).eq('deck_idx', deckIdx).eq('side', side);
    return (data ?? []).reduce((n, r) => n + (Number(r.qty) || 1), 0);
  };
  const subsFor = async (userId) => {
    const { data } = await sb.from('vs_submissions').select('id, target_id, status, quantity')
      .eq('event_id', game.id).eq('user_id', userId).order('submitted_at');
    return data ?? [];
  };
  const piecesIn = async (col) => {
    const { data } = await sb.from('vs_connect4_pieces').select('id, row, deck_idx, status, submission_id, item_name')
      .eq('event_id', game.id).eq('col', col).order('row');
    return data ?? [];
  };
  const reject = async (submissionId) => {
    const fd = new FormData();
    fd.set('source', 'generic');
    fd.set('ids', submissionId);
    fd.set('decision', 'reject');
    fd.set('reject_kind', 'full');
    fd.set('note', 'verification: not a valid claim');
    const req = new Request('http://local/admin/submissions?/decide', { method: 'POST', body: fd });
    return admin.actions.decide({ request: req, locals: { user: adminUser } });
  };

  // ══ FIX 1 — a full rejection gives the bank back ═══════════════════════════
  // Column C is the ×1000 tile; its live slot is 2*4 = 8.
  const C = 2, SLOT_C = 8;
  const r1 = await submit(red1, C, { quantity: 600 });
  console.log('claim 600/1000 →', JSON.stringify(r1));
  const banked = await bankFor(SLOT_C, 1);
  check(banked === 600, `600 of a x1000 tile banks 600 (got ${banked})`);
  check((await piecesIn(C)).length === 0, `a partial-cover claim places no piece (got ${(await piecesIn(C)).length})`);

  const cSub = (await subsFor(red1.id)).find((s) => s.target_id === `c4:${C}:${SLOT_C}`);
  await reject(cSub.id);
  const afterBank = await bankFor(SLOT_C, 1);
  check(afterBank === 0, `FIX 1 — a full rejection clears the bank (was 600, now ${afterBank})`);

  // And the tile must still be winnable from scratch, not from 600.
  await submit(red2, C, { quantity: 400 });
  const rebuilt = await bankFor(SLOT_C, 1);
  check(rebuilt === 400, `a later 400 banks 400, not 1000 (got ${rebuilt})`);
  check((await piecesIn(C)).length === 0, `...and still places no piece (got ${(await piecesIn(C)).length})`);

  // ══ FIX 2 — a second claim in a column you already hold pending ════════════
  const A = 0;
  const first = await submit(red1, A, {});
  const afterFirst = await piecesIn(A);
  const firstPiece = afterFirst[0];
  console.log('first claim in A →', JSON.stringify(first));
  check(afterFirst.length === 1, `the first claim places a piece (got ${afterFirst.length})`);

  const second = await submit(red1, A, {});
  const afterSecond = await piecesIn(A);
  console.log('second claim in A →', JSON.stringify(second));
  check(
    afterSecond.length === 2,
    `FIX 2 — a second claim places its OWN piece (column A holds ${afterSecond.length})`
  );
  check(
    !second?.resubmitted,
    `FIX 2 — it is not reported as a resubmit (resubmitted=${second?.resubmitted ?? false})`
  );
  const firstNow = afterSecond.find((p) => p.id === firstPiece?.id);
  check(
    firstNow?.submission_id === firstPiece?.submission_id,
    `FIX 2 — the first claim keeps its own proof (${firstPiece?.submission_id === firstNow?.submission_id ? 'unchanged' : 'STOLEN'})`
  );
  check(
    afterSecond.length === 2 && afterSecond[0].deck_idx !== afterSecond[1].deck_idx,
    `the two pieces hold different tiles (${afterSecond.map((p) => p.item_name).join(' / ')})`
  );

  // ══ the resubmit path must STILL work ══════════════════════════════════════
  // Send the second claim back, then resubmit for it: one piece, new proof.
  const aSubs = await subsFor(red1.id);
  const lastA = aSubs.filter((s) => s.target_id.startsWith(`c4:${A}:`)).pop();
  const fd = new FormData();
  fd.set('source', 'generic'); fd.set('ids', lastA.id); fd.set('decision', 'reject');
  fd.set('reject_kind', 'partial'); fd.set('note', 'better shot please');
  await admin.actions.decide({
    request: new Request('http://local/admin/submissions?/decide', { method: 'POST', body: fd }),
    locals: { user: adminUser }
  });
  const held = (await piecesIn(A)).length;
  const redo = await submit(red1, A, { resubmit: true });
  const afterRedo = await piecesIn(A);
  check(!!redo?.resubmitted, `a real resubmit is still recognised (resubmitted=${redo?.resubmitted ?? false})`);
  check(afterRedo.length === held, `a resubmit places no extra piece (${held} → ${afterRedo.length})`);
  const newSub = (await subsFor(red1.id)).filter((s) => s.target_id.startsWith(`c4:${A}:`)).pop();
  const repointed = afterRedo.some((p) => p.submission_id === newSub.id);
  check(repointed, `a resubmit repoints the held piece at the new proof`);

  console.log('\n──────── PASS ────────');
  for (const m of ok) console.log('  ✓', m);
  if (bad.length) {
    console.log('\n──────── FAIL ────────');
    for (const m of bad) console.log('  ✗', m);
  }
  console.log(`\n${ok.length} passed, ${bad.length} failed`);
} finally {
  await server.close();
}
process.exit(bad.length ? 1 : 0);
