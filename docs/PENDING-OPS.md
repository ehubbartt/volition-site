# Pending operations — run these by hand

Everything below needs the maintainer (Supabase dashboard, Fly CLI, or wrangler).
Nothing here is done by a deploy. Delete sections as you complete them.

> Pruned 2026-08-21: the old sections for the refactor ship, the hand-applied SQL
> backlog, Dink auto-tracking go-live, and the drain-pipeline **secrets** are done
> (per the maintainer) and have been removed. What's left is below.

---

## 0a. ☐ RE-RUN `db/scripts/connect4.sql` — needed before the review flow works

It gained `vs_connect4_pieces.status` and `.submission_id` (provisional pieces) on top
of the earlier `vs_connect4_bonus` table. Until it is applied:

* a submitted claim still places a piece, but it is confirmed on the spot and cannot be
  reviewed (the insert falls back to the old column set on purpose, so nothing breaks);
* the two rejections, the column shift and the tile requeue do nothing;
* the waiting-room panel under the member board stays empty.

Nothing errors — it simply behaves like the pre-review build. Verify afterwards with
`npm run drill:connect4:review`, which refuses to run until the columns exist and then
walks submit → resubmit → stack → full reject → column shift → tile back on offer.

---

## 0. Connect Four runs on manual proof (no action needed, context only)

`DINK_AUTO_TRACKING` in `src/lib/server/connect4.ts` is `false`, so a live game projects
nothing into the Dink allowlist and no drop can auto-credit a tile. Members submit a
screenshot per column from the member board; the rows land in `/admin/submissions`, show
**when that tile went up**, and approval is gated behind a checkbox that the in-game drop
time is later. Approving is what places the piece.

Restoring Dink crediting later is one constant back to `true` — nothing else changed.

---

## 1. Deploy the worker half of the drop-drain pipeline

The secrets exist everywhere (both Fly apps + the Worker), but the **code that uses
them is not deployed**: the proxy's after-insert ping and the two crons live on the
`drop-drain-ping` branch, which is not merged to `master` — and CI deploys `master`.
Until it merges, drops are still credited only by the poll-on-read backstop.

```sh
# In the dink-proxy repo:
# 1. Fill in SITE_URL in wrangler.jsonc on the drop-drain-ping branch — it ships
#    BLANK on purpose. Use the CANONICAL prod site URL (the prod app's
#    PUBLIC_SITE_URL value; an off-canonical host would 308 the ping).
# 2. Merge drop-drain-ping → master and push; CI deploys.
```

Verify: `npx wrangler tail` during a simulated drop shows the insert followed by the
drain ping, and `/admin/dink-drops` shows the drop processed within ~2s. Then take
the latency + race-window measurements listed in [`LIVE-UPDATES.md`](LIVE-UPDATES.md)
"How to verify" and record them there.

> Staging has its own rehearsal path, no deploy of `master` needed:
> `npx wrangler deploy --env staging` (from the `drop-drain-ping` branch) stands up
> **dink-proxy-staging** — same code, pointed at the staging DB and staging site,
> Discord webhooks deliberately absent. Set its two secrets once with
> `--env staging`. For a no-deploy rehearsal, `scripts/send-test-drop.mjs` drives
> the worker in-process against staging — with `SITE_URL` + `DINK_PROCESS_SECRET`
> in the shell it exercises the drain ping too. **Rehearse against a NON-test
> game**: test games refuse real-shaped drop keys by design. Verified end-to-end:
> manufactured drop → worker → staging DB → consumer → piece on the board in 2.4s.

---

## 2. RLS lockdown (security)

Goal: the anon key can read/write **nothing**; every server talks to Supabase with
the service-role key. Until step 2.2 runs, the database behaves exactly as today.

> Mechanism PROVEN end-to-end via `db/scripts/rls_test.sql` + `/admin/rls-test` on
> staging. **Key distribution is DONE** (staging site, prod site, bot, Dink proxy
> all run the service-role key). What's left is flipping it on.

### 2.1 ☐ Canary (instantly reversible)
```sql
alter table public.wordles enable row level security;
```
Check: site loads, bot responds, a Dink drop tracks. If something breaks, that
consumer didn't get the key — `disable row level security` reverses the canary.

### 2.2 ☐ Full lockdown
Run ALL of `db/scripts/enable_rls.sql` in the Supabase SQL editor. It has THREE
parts — tables, views (they bypass table RLS without `security_invoker`), and RPC
functions (anon can call them by default). Run the whole file.

### 2.3 ☐ Verify
With the ANON key (from any machine):
```sh
curl "https://rrnmckaabbvtkkpoeefg.supabase.co/rest/v1/players?select=rsn&limit=1" \
  -H "apikey: <anon>" -H "authorization: Bearer <anon>"          # expect []
# vs_active_participants (view) and rpc/get_public_tables → expect permission denied
```
Dashboard linter: the `rls_disabled_in_public` warnings disappear. Then click
around the site, run a bot command that writes (wallet/points), and drop-test Dink.

Also run once and eyeball (functions with `prosecdef = true` are SECURITY DEFINER —
fine now that anon can't call them, but good to know they exist):
```sql
select proname, prosecdef from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public';
```

### 2.4 ☐ Optional hardening (any time after 2.3)
Rotate the anon key in the dashboard — the old one had full access its whole life
and nothing depends on it after the lockdown.

### 2.5 ☐ Test-scaffold cleanup
Run SECTION 3 of `db/scripts/rls_test.sql` (drops the throwaway test
table/view/function). Optionally remove the `/admin/rls-test` route, or keep it as
a re-runnable diagnostic.

---

## 3. Dink delivery modes + the relay — PARKED

> Built and pushed, deliberately **not shipped**. The clan-vs-clan event runs on manual
> proof instead (only one clan had Dink set up, which was a head start rather than a
> convenience), so none of this is on the critical path. Nothing here is deployed and
> nothing depends on it — pick it up when the event is over.
>
> Site work is on `staging`; proxy work is on `dink-delivery-modes`. Neither the SQL nor
> the proxy deploy has been done, and until they are, everything behaves exactly as it
> did before.



1. ☐ Apply `db/scripts/dink_modes_and_relays.sql` to **both** databases. Adds
   `dink_tokens.mode` / `.forward_clan` and the `vs_dink_relays` table. Until it
   lands, `/dink-check` falls back to the old single-choice behaviour (the reads
   degrade to defaults) and the proxy treats every token as `standard` +
   `forward_clan`, i.e. exactly today's behaviour.
2. ☐ Deploy the **proxy** (`dink-proxy`): the mode-aware config, the visitor gate and
   the relay fan-out all live on branch **`dink-delivery-modes`** (one commit off
   `master`). CI deploys `master`, so it needs merging.
   **There are now two unmerged proxy branches**, and they are independent —
   `dink-delivery-modes` (this) and `drop-drain-ping` (section 1, still not merged;
   `master` has no drain ping). Merging either alone is fine; decide whether to
   ship them together or one at a time.
3. ☐ Smoke-test each shape on staging once the SQL is applied: a visitor token's drop
   is recorded but absent from the clan feed; a relay destination receives a post at
   its own floor; a `multi_server` token still gets the 3M floor.

---

## 4. Connect Four production go-live

1. ☑ Merge `staging` → `main` — 2026-08-27 (fast-forward) and again 2026-09-08
   (a merge commit this time: `main` had picked up the personal-bingo PRs #77
   and #78 independently). Prod deploys itself off `main`.
2. ☑ **Apply `db/scripts/connect4.sql`** — PROD applied 2026-09-09 (per the
   maintainer); STAGING applied and proven by `npm run drill:connect4` (claims on
   6×4 and 12×6 boards, quantity tiles credited).
   Confirm any time with `select to_regclass('public.vs_connect4_progress');` —
   `null` would mean it never landed. What it fixes, if a future database ever
   misses it: quantity ("drops needed") tiles have nowhere to bank progress, and
   any board that is not exactly 25×10 fails **every** claim (the old bounds
   constraint hardcoded `deck_idx = col * 10 + row`). Not touching the drops knob
   is no way to dodge it — smart fill manufactures ×N-drops tiles by itself
   whenever the filtered candidate list is smaller than the board.
3. ☐ Confirm `/admin/connect4` loads on prod, then create the game, curate the
   pool, **Preview** the clan split, fix the flagged names, seat, start. Members
   watch at `/events/<slug>/connect4`.

Everything else about the event (who can sign up, how sides are decided) is in
[`CONNECT4.md`](CONNECT4.md) § "Clan vs clan".
