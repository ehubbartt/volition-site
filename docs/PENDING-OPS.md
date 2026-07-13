# Pending operations — run these by hand

Everything below needs the maintainer (Supabase dashboard, Fly CLI, or wrangler).
Nothing here is done by a deploy. Ordered by priority; each section is independent
except where marked. Delete sections as you complete them.

---

## 1. RLS lockdown (security — do this first)

Goal: the anon key can read/write **nothing**; every server talks to Supabase with
the service-role key. Until step 1.4 runs, the database behaves exactly as today.

> **Mechanism PROVEN end-to-end** via `db/scripts/rls_test.sql` + `/admin/rls-test`
> on staging: anon key blocked on a locked table/view/function; service key reads
> everything with RLS on. What's left is distributing the key + running the script.

**Order matters: 1.2 → 1.3 must ALL be done before 1.4.**

### 1.1 Copy the service-role key — ✅ DONE
(Already used to configure staging.) Supabase dashboard → Project Settings → API →
`service_role` key. Never commit it, never put it in client code.

### 1.2 Hand it to every server — ✅ staging done · ☐ prod · ☐ bot
```sh
# ✅ DONE: volition-site-staging has SUPABASE_SERVICE_ROLE_KEY and runs on it.

# ☐ PROD SITE — runs pre-refactor code from main, which only reads
#   SUPABASE_ANON_KEY. Adding a new var does NOTHING; you must overwrite the
#   EXISTING variable's VALUE with the service-role key (rename properly when
#   the refactor ships to prod, see section 4):
flyctl secrets set SUPABASE_ANON_KEY=<service_role_key> -a volition-site

# ☐ BOT — code already deployed with service-key support:
flyctl secrets set SUPABASE_SERVICE_ROLE_KEY=<service_role_key> -a <bot app name>
```
Each `secrets set` restarts the app by itself — **no separate deploy needed**. Use
the flyctl CLI, NOT the Fly dashboard's deploy button: the dashboard's GitHub
integration builds from `main`, which is the wrong branch for staging (its failed
build is how we learned this — see the note at the end of this section).

### 1.3 ☐ The Dink proxy Worker (easy to forget — it writes drops to the DB)
From the `dink-proxy` repo:
```sh
npx wrangler secret put SUPABASE_KEY    # paste the service-role key
```
No code change; it's a value swap.

Also add `SUPABASE_SERVICE_ROLE_KEY=<key>` to the `.env` on your dev machine
(the card-art / analytics scripts use it).

### 1.4 ☐ Flip RLS on (Supabase dashboard → SQL editor)
1. **Canary** (instantly reversible):
   ```sql
   alter table public.wordles enable row level security;
   ```
   Check: site loads, bot responds, a Dink drop tracks. If something breaks, that
   consumer didn't get the key — `disable row level security` reverses the canary.
2. **Full lockdown**: run ALL of `db/scripts/enable_rls.sql`. It has THREE parts —
   tables, views (they bypass table RLS without `security_invoker`), and RPC
   functions (anon can call them by default). Run the whole file.

### 1.5 ☐ Verify
With the ANON key (from any machine):
```sh
curl "https://rrnmckaabbvtkkpoeefg.supabase.co/rest/v1/players?select=rsn&limit=1" \
  -H "apikey: <anon>" -H "authorization: Bearer <anon>"          # expect []
# vs_active_participants (view) and rpc/get_public_tables → expect permission denied
```
Dashboard linter: the `rls_disabled_in_public` warnings disappear. Then click
around the site, run a bot command that writes (wallet/points), and drop-test Dink.

Also run this once and eyeball the output (functions with `prosecdef = true` are
SECURITY DEFINER — fine now that anon can't call them, but good to know they exist):
```sql
select proname, prosecdef from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public';
```

### 1.6 Optional hardening (any time after 1.5)
Rotate the anon key in the dashboard — the old one had full access its whole life.
Nothing depends on it after the lockdown, so this closes any unknown historical
exposure for free. (Note: prod temporarily carries the service-role key in the
`SUPABASE_ANON_KEY` variable per 1.2 — rotating the anon key doesn't affect that;
just don't overwrite prod's variable with the NEW anon key by habit.)

### 1.7 ☐ Test-scaffold cleanup
- Run SECTION 3 of `db/scripts/rls_test.sql` (drops the throwaway
  `vs_rls_test` table/view/function).
- Optional: remove the `/admin/rls-test` route + `db/scripts/rls_test.sql` from the
  branch, or keep them as a re-runnable staging diagnostic.

### Deploy-source gotcha (why the dashboard deploy failed)
`volition-site-staging`'s Fly-native GitHub integration is pinned to the repo's
default branch (`main`), so the dashboard's "deploy" button builds the WRONG branch
and fails. Staging's real deploy path is the GitHub Actions workflow
(`deploy-staging.yml`, builds `voli-site-2.0-refactor`; auto on push, or the
"Run workflow" button). Fix when convenient: disconnect the GitHub integration on
the staging app (or repoint it at the refactor branch) in the Fly dashboard.

---

## 2. Hand-applied SQL — what's applied vs pending

There's no migration runner; these run in the Supabase SQL editor. Status is
inferred from what's live — each row has a check query if you're unsure.

| Script | Status | Check / notes |
|---|---|---|
| `db/scripts/active_tiles.sql` | **RE-APPLY** | Updated with `security_invoker` on its 3 views. Safe to re-run (idempotent; drops/recreates two views). If you run section 1.4 first this is belt-and-braces; still re-apply so future re-runs stay locked. |
| `db/scripts/dink_tracking_hardening.sql` | **PENDING** | Required before Dink auto-tracking goes live (section 3). Safe to re-run. |
| `db/scripts/ehb_overrides.sql` | **PROBABLY PENDING** | `/admin/ehb` (staging) errors without it. Check: `select 1 from vs_ehb_overrides limit 1;` |
| `db/scripts/events_v2.sql` | likely applied | Personal boards run on this spine in prod. Check: `select 1 from vs_event_participants limit 1;` Safe to re-run (additive + idempotent). |
| `db/scripts/events_unlisted.sql` | **RUN with Dink go-live** | Adds `vs_events.unlisted` + creates the permanent Dink Self-Test event that `/dink-check` auto-enrolls into. Run BEFORE deploying the site build that filters on `unlisted`, and before the bot's unlisted-filter branch merges. |
| `db/scripts/vs_rank_sim.sql` | applied | The `gear_detail`/`ca_detail` alters were run while fixing "Check my rank" (which now saves fine). Check: `select gear_detail from vs_rank_sim limit 1;` |
| `db/scripts/create_vs_admin_roles.sql` | applied | DB role grants are live. |
| `db/functions/vs_accept_invite.sql` | applied | Team invites work in prod. |
| `db/scripts/grant_white_pack.sql` | one-off utility | Run only when granting. |
| bot `db/migrations/add_vs_event_id_to_events.sql` | applied | Announce poller is live. |
| bot `db/migrations/create_bot_config_table.sql` + `seed_command_messages.sql` | applied | `/admin/config` + `/allset` work. |

---

## 3. Dink auto-tracking go-live (when you're ready — after sections 1 & 2)

Reference: `docs/event-builder-and-dink-tracking.md`. Remaining setup:

1. Apply `dink_tracking_hardening.sql` and (re-)apply `active_tiles.sql` (section 2).
2. Worker: `SUPABASE_URL` var + `SUPABASE_KEY` secret (already service-role after
   1.3), then `npx wrangler deploy` from the `dink-proxy` repo.
3. Site env (Fly secret): `PROXY_BASE_URL=https://dink-proxy.<account>.workers.dev`
   so `/admin/dink-test` can mint tokens.
4. Test path: the doc's section "A. Proxy in isolation" (local `wrangler dev`),
   then `/admin/dink-test` end-to-end, then watch `/admin/dink-drops`.

---

## 4. Ship the refactor branch to prod (when staging has soaked)

`voli-site-2.0-refactor` (staging) is far ahead of `main` (prod): instant
navigation on all member + core admin pages, bans/session caches, gzip, bingo URL
unification, service-key support. When you're satisfied with staging:

1. **Squash-merge** `voli-site-2.0-refactor` → `main` (prod deploys from main).
   Use squash on purpose: a handful of early commits were authored as "Claude"
   with attribution trailers, and two merge commits carry `claude/*` branch names
   — squashing collapses all of it into one commit authored by you, so none of it
   reaches `main`'s history. (The code content is already clean.)
2. Then rename prod's key secret properly:
   ```sh
   flyctl secrets set SUPABASE_SERVICE_ROLE_KEY=<key> -a volition-site
   # optional cleanup once confirmed: flyctl secrets unset SUPABASE_ANON_KEY -a volition-site
   ```
3. Old URLs 301 (`/bingo/[slug]` → `/events/[slug]`, `/clog-bingo` →
   `/events/personal-bingo`), so nothing external breaks.

Staging smoke list before merging: back/forward navigation paints real content
instantly; join/leave an event (data stays on screen while refreshing); admin
pages show "Loading…" then fill; `/admin/stats` and `/admin/voice` on a fresh
browser profile (first-visit placeholder path); logout fully reloads.

---

## 5. Housekeeping (whenever)

- Bot repo branches: `architecture-docs` and `editable-command-messages` are fully
  merged — safe to delete. `repo-authoring-conventions` has one superseded commit
  (its content already lives on main) — skim then delete.
- The Supabase linter may also flag storage buckets or `security definer` views
  after the lockdown; buckets are intentionally public-read (bingo proofs, card
  art), and the definer-function audit is covered in 1.5.
