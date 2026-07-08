# Database & tables

How the site talks to Supabase, the authorization posture, and the tables it owns/reads.
Pair with `docs/EVENTS.md` for the events data spine. Update this doc when you add a table
or change the access/authorization model.

## Access (`src/lib/server/db.ts`)

- `db()` returns a singleton Supabase client (`SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY`,
  falling back to `SUPABASE_ANON_KEY` only in dev). All DB access is **server-side only**
  (`src/lib/server/`) — never query Supabase from client code.
- PostgREST caps a plain select at 1000 rows; use `selectAll(table, cols)` for full-table
  reads and `fetchAllFiltered(make)` for paged filtered reads to avoid silent truncation.
- Hand-applied SQL only — there is **no migration runner**. New tables/functions live in
  `db/scripts/` and `db/functions/` and are run manually against Supabase. (The repo's
  `.gitignore` excludes `db/migrations/`, so don't put committed SQL there.)

## Authorization posture (important)

- **RLS is deny-all on every public table** (`db/scripts/enable_rls.sql` — RLS enabled with
  NO policies; views set `security_invoker`; function EXECUTE revoked from anon). The
  service-role key bypasses RLS; the anon key can read/write **nothing**, so an anon-key
  leak is harmless. The service key is server-only and must never appear in client code or a
  `PUBLIC_`-prefixed env var (see `db()` fail-fast in prod when it's missing).
- App-code gates (`isAdmin`/`isSuperAdmin`, the endpoint role factories) are still the
  authorization boundary for *who can do what* — RLS is a blast-radius backstop, not a
  per-user policy layer. The generic table editor (`/admin/tables/*`) reads/writes *any*
  table, so its route guard is security-critical (`superAdminEndpoint`).
- **Money writes** (`players.points` / `gold_balance` in `playerStats.ts`) use optimistic
  concurrency (read → CAS-update only if unchanged) with a short retry, since the client has
  no transactions. Refunds/credits go through the shared `grantColumn` helper so the lock is
  identical everywhere.
- **Error-handling convention.** Reads **fail open** (return `null`/empty on error so a page
  still renders); writes return a structured `{ ok, error }` result; external integrations
  (Discord webhooks, ops alerts) **swallow + log** and never throw into the request.
- **External fetches** go through `src/lib/server/http.ts` (`serverFetch`/`getJson`/`postJson`),
  which add an abort-on-timeout deadline — Node's global `fetch` has none, so an upstream
  stall would otherwise hang a page load or form action.

## Key tables (by area)

- **Identity/session:** `vs_users` (members; discord_id, rsn, clan_allegiance,
  account_type, …), `vs_sessions` (token, user_id, expires_at), `vs_admin_roles`
  (owner-granted admin/card_tester), `vs_audit_log` (admin action trail).
- **Events & tasks:** `vs_events`, `vs_event_signups`, `vs_teams`, `vs_team_invites`,
  `vs_tasks`, `vs_submissions`, plus team-progress tables for the board game
  (completions, swaps, path choices) and `vs_duo_tiles`. Postgres function
  `vs_accept_invite(...)` atomically forms a team on invite accept (`db/functions/`).
- **Bingo:** `vs_bingo_completions` (+ admin tile management).
- **Cards ("gamba"):** `vs_cards`, `vs_card_packs`, `vs_user_cards`, `vs_user_packs`,
  `vs_pack_opens` (+ pulled-card records).
- **Home/calendar:** `vs_calendar_events`.
- **Shared (bot-owned):** `players` (roster/ranks on the home page), `bans` (ban gate),
  `bot_config` (edited at `/admin/config`).

> Treat the column lists as a guide, not a contract — confirm against the code/DB before
> relying on exact fields. Site-owned tables are prefixed **`vs_`**; the site also reads a
> few **bot-owned** tables (`players`, `bans`, `bot_config`).

**Building a new event/board/bingo?** Don't add tables — follow the standard in
**[`EVENTS.md`](EVENTS.md)** (the shared `vs_events` + `vs_tiles` + `vs_submissions` ledger
+ `vs_active_tiles` view spine + a per-`kind` strategy module).
