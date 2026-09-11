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
const DECK_NEXT = 'Twisted bow'; // what sits behind column E's offer, for the race check

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

  // ══ FIX 3 — the loser of a column race claims NOTHING ══════════════════════
  // Column E offers 'Ancestral hat' (slot 16); 'Twisted bow' (17) is behind it. Two
  // players post for E at once. The winner takes the hat; the loser must be told they
  // lost, NOT quietly handed the bow their screenshot says nothing about.
  const E = 4, HAT = 16;
  const yellow = (await users(['332338153597829122']))[0];
  const [pA, pB] = await Promise.all([submit(red1, E, {}), submit(yellow, E, {})]);
  const inE = await piecesIn(E);
  const won = [pA, pB].filter((r) => r?.cell);
  const lost = [pA, pB].filter((r) => r?.tileTaken);
  console.log('race in E →', JSON.stringify([pA, pB]));
  check(inE.length === 1, `FIX 3 — a column race places ONE piece (got ${inE.length})`);
  check(won.length === 1, `FIX 3 — exactly one claimant is told they won (got ${won.length})`);
  check(lost.length === 1, `FIX 3 — the loser is told the tile was taken (got ${lost.length})`);
  check(
    inE[0]?.deck_idx === HAT,
    `FIX 3 — the piece carries the tile that was on offer (slot ${inE[0]?.deck_idx}, "${inE[0]?.item_name}")`
  );
  check(
    !inE.some((p) => p.deck_idx === HAT + 1),
    `FIX 3 — nobody is credited the tile BEHIND it ("${DECK_NEXT}")`
  );

  // A later, honest claim for what column E offers NOW must still work.
  const after = await submit(red1, E, {});
  const inE2 = await piecesIn(E);
  check(!!after?.cell, `the next claim in that column still succeeds (${after?.cell ?? 'refused'})`);
  check(inE2.length === 2, `...and places a second piece (got ${inE2.length})`);

  // ══ FIX 4 — a mistaken approval can be taken back off the board ════════════
  // The path a reviewer actually took: approve, realise it was wrong, un-approve, then
  // reject. Every step used to leave the piece standing — the revoke never settled the
  // board, and the reject after it matched nothing because the row was already rejected.
  const F = 5;
  await submit(red1, F, {});
  const fSub = (await subsFor(red1.id)).filter((x) => x.target_id.startsWith(`c4:${F}:`)).pop();
  const decide = async (id, decision, kind) => {
    const fd = new FormData();
    fd.set('source', 'generic');
    fd.set('ids', id);
    fd.set('decision', decision);
    if (kind) fd.set('reject_kind', kind);
    return admin.actions.decide({
      request: new Request('http://local/admin/submissions?/decide', { method: 'POST', body: fd }),
      locals: { user: adminUser }
    });
  };
  const revoke = async (id) => {
    const fd = new FormData();
    fd.set('source', 'generic');
    fd.set('ids', id);
    return admin.actions.revoke({
      request: new Request('http://local/admin/submissions?/revoke', { method: 'POST', body: fd }),
      locals: { user: adminUser }
    });
  };

  await decide(fSub.id, 'approve');
  check((await piecesIn(F)).length === 1, `an approved claim stands on the board`);
  await revoke(fSub.id);
  check(
    (await piecesIn(F)).length === 0,
    `FIX 4 — un-approving takes the piece back off (column F holds ${(await piecesIn(F)).length})`
  );

  // Rejecting an APPROVED row is deliberately not allowed — un-approving is the path,
  // because that is what reverses the VP and reclaims the pack. What must NOT happen is
  // it failing silently, which is how a mistaken approval stayed on the board while the
  // reviewer believed they had rejected it.
  await submit(red2, F, {});
  const f2 = (await subsFor(red2.id)).filter((x) => x.target_id.startsWith(`c4:${F}:`)).pop();
  await decide(f2.id, 'approve');
  const standing = (await piecesIn(F)).length;
  const refused = await decide(f2.id, 'reject', 'full');
  check(
    refused?.status === 409 && /already approved/i.test(refused?.data?.error ?? ''),
    `FIX 4 — rejecting an approved claim is REFUSED, not silently ignored (${refused?.status ?? 'no status'})`
  );
  check((await piecesIn(F)).length === standing, `...and the board is untouched by the refusal`);
  await revoke(f2.id);
  check((await piecesIn(F)).length === standing - 1, `un-approving it then frees the tile`);

  // A second admin pressing approve on a row that is already approved must be TOLD, not
  // silently ignored — and must not place a second piece.
  await submit(red2, F, {});
  const f4 = (await subsFor(red2.id)).filter((x) => x.target_id.startsWith(`c4:${F}:`)).pop();
  await decide(f4.id, 'approve');
  const once = (await piecesIn(F)).length;
  const twice = await decide(f4.id, 'approve');
  check(
    twice?.status === 409 && /already approved/i.test(twice?.data?.error ?? ''),
    `FIX 4 — a second approval is refused with a reason (${twice?.status ?? 'no status'})`
  );
  check((await piecesIn(F)).length === once, `...and places no second piece (${once} → ${(await piecesIn(F)).length})`);
  await revoke(f4.id);

  // Escalating "Ask again" to "Reject & free tile" must work — the row is already
  // 'rejected' by then, which is exactly the state the old filter refused to match.
  await submit(red1, F, {});
  const heldF = (await piecesIn(F)).length;
  const f3 = (await subsFor(red1.id)).filter((x) => x.target_id.startsWith(`c4:${F}:`)).pop();
  await decide(f3.id, 'reject', 'partial');
  check((await piecesIn(F)).length === heldF, `an "Ask again" leaves the piece standing`);
  await decide(f3.id, 'reject', 'full');
  check(
    (await piecesIn(F)).length === heldF - 1,
    `FIX 4 — escalating to a full rejection then frees it (${heldF} → ${(await piecesIn(F)).length})`
  );

  // ══ PETS — points beside the board, no cell ════════════════════════════════
  const petBonuses = async () => {
    const { data } = await sb.from('vs_connect4_bonus').select('id, side, points, item_name, drop_key')
      .eq('event_id', game.id);
    return data ?? [];
  };
  const petRes = await member.actions.submitPet({
    request: (() => {
      const fd = new FormData();
      fd.set('pet', 'Nexling');
      fd.append('proof', proof());
      return new Request(`http://local/events/${SLUG}/connect4?/submitPet`, { method: 'POST', body: fd });
    })(),
    locals: { user: red1 },
    params: { slug: SLUG }
  });
  console.log('pet submit →', JSON.stringify(petRes));
  check(petRes?.submitted === true && petRes?.pet === 'Nexling', `a pet can be submitted from the board`);
  check((await petBonuses()).length === 0, `submitting a pet awards NOTHING yet (review does)`);
  const piecesBefore = (await piecesIn(0)).length + (await piecesIn(1)).length;

  const petSub = (await subsFor(red1.id)).filter((x) => x.target_id === 'c4:pet').pop();
  await decide(petSub.id, 'approve');
  const paid = await petBonuses();
  check(paid.length === 1, `approving it awards exactly one bonus (got ${paid.length})`);
  check(paid[0]?.side === 1, `...to the submitter's own side (side ${paid[0]?.side})`);
  check(paid[0]?.item_name === 'Nexling', `...naming the pet ("${paid[0]?.item_name}")`);
  check(
    (await piecesIn(0)).length + (await piecesIn(1)).length === piecesBefore,
    `...and places no piece on the board`
  );

  // Revoke then re-approve must not pay twice.
  await revoke(petSub.id);
  await decide(petSub.id, 'approve');
  check((await petBonuses()).length === 1, `re-approving after a revoke does not pay twice`);

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
