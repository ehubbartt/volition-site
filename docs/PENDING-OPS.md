# Pending operations — run these by hand

Everything below needs the maintainer (Supabase dashboard, Fly CLI, or wrangler).
Nothing here is done by a deploy. Delete sections as you complete them.

> Pruned 2026-08-21: the old sections for the refactor ship, the hand-applied SQL
> backlog, Dink auto-tracking go-live, and the drain-pipeline **secrets** are done
> (per the maintainer) and have been removed. What's left is below.

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

## 3. Connect Four production go-live (order matters)

1. ☐ Apply `db/scripts/connect4.sql` to the **prod** database (idempotent).
2. ☐ Merge `staging` → `main` (fast-forward as of this writing; prod deploys itself).
3. ☐ Confirm `/admin/connect4` loads on prod, then create the game, curate the
   pool, **Preview** the clan split, fix the flagged names, seat, start.

Do not create-and-start a connect4 game on prod between steps 1 and 2 being in the
wrong order — claims would fail against the missing table. Everything else about
the event (who can sign up, how sides are decided) is in
[`CONNECT4.md`](CONNECT4.md) § "Clan vs clan".
