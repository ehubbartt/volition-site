# Volition Site — Architecture

How the SvelteKit web app is put together. Pair this with `CLAUDE.md` (conventions +
quick orientation). Update this doc when you change how a system works.

## Stack & runtime

- **SvelteKit 2 / Svelte 5 (runes)**, TypeScript, `@sveltejs/adapter-node` (SSR).
- Runs as a Node server (`node build`) on **Fly.io** (`fly.toml`, `Dockerfile`, Node 22).
- Data layer: **Supabase Postgres** via `@supabase/supabase-js`. All DB access is
  server-side only (`src/lib/server/`); the anon key is used and RLS is effectively off,
  so **never** query Supabase from client code.
- Other libs: `arctic` (Discord OAuth), `three` (3D cards), `sharp`, `marked`, `zod`.
- `/health` returns JSON and bypasses auth/redirects for Fly's uptime probe.
- Scripts: `npm run dev`, `npm run build`, `npm run check` (svelte-check). No automated
  test suite — run `check` before pushing and verify changes manually.

## Request lifecycle (`src/hooks.server.ts`)

Every request passes through the handle hook, in order:
1. **Health probe** short-circuit (`/health`).
2. **Canonical-host redirect** — forces one origin in prod so Discord OAuth cookies and
   the callback stay on the same host (avoids "Invalid OAuth state").
3. **Session load** — `readSession()` sets `event.locals.user` / `sessionId`.
4. **Admin-role cache refresh** — `ensureFreshAdminRoles()` (see Roles below).
5. **Ban check** — banned users are redirected to `/banned` (reads the bot's `bans` table).
6. **Audit capture** — for admin POSTs, snapshots the payload + prior row state, then
   logs the result after the response (see Audit).

## Auth, sessions & roles

- **Login:** Discord OAuth via `arctic`. `src/routes/auth/discord/login` sets a state
  cookie and redirects; `.../callback` exchanges the code, upserts `vs_users`, creates a
  `vs_sessions` row, and sets the `vs_session` HTTP-only cookie. First-time users go to
  `/onboarding`. `src/lib/server/auth.ts` owns session create/read/destroy.
- **Roles** (`src/lib/server/auth.ts`) are the union of **env allow-lists** and
  **DB grants**:
  - `isSuperAdmin` — `SUPER_ADMIN_DISCORD_IDS` only (owners; the highest tier; can use the
    generic table editor and bot-config editor). Intentionally **env-only** — never
    grantable from the UI, so a compromised admin can't escalate to owner.
  - `isAdmin` — `ADMIN_DISCORD_IDS` ∪ super admins ∪ `vs_admin_roles` grants (role `admin`).
  - `isCardTester` — `CARD_TESTER_DISCORD_IDS` ∪ `vs_admin_roles` grants (role `card_tester`).
    Full card/pack CRUD; independent of admin.
  - `isCardAdmin` = `isAdmin || isCardTester` (view-level access to the cards area).
- **DB-backed grants:** `vs_admin_roles` is managed by owners at `/admin/admins`.
  `src/lib/server/adminRoles.ts` keeps a ~30s in-memory cache of those grants, refreshed
  once per request in the hook, so `isAdmin()`/`isCardTester()` stay **synchronous** at
  their ~50 call sites. Fail-open for env roles, fail-closed for DB grants on a DB error.

## Database (`src/lib/server/db.ts`)

- `db()` returns a singleton Supabase client (`SUPABASE_URL` + `SUPABASE_ANON_KEY`).
- PostgREST caps a plain select at 1000 rows; use `selectAll(table, cols)` for full-table
  reads and `fetchAllFiltered(make)` for paged filtered reads to avoid silent truncation.
- **Convention:** site-owned tables are prefixed **`vs_`**. The site also reads a few
  **bot-owned** tables (`players`, `bans`, `bot_config`).
- Hand-applied SQL only — there is **no migration runner**. New tables/functions live in
  `db/scripts/` and `db/functions/` and are run manually against Supabase. (Note: the
  repo's `.gitignore` excludes `db/migrations/`, so don't put committed SQL there.)

### Key tables (by area)
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
> relying on exact fields.

## Routes & features

Filesystem routing under `src/routes/`; pages pair a `+page.svelte` with a
`+page.server.ts` (loaders + form actions).

- **Public:** `/` (roster, calendar, event counts), `/onboarding`, `/me`, `/u/[rsn]`,
  `/auth/*`, `/banned`, `/login-busy` (Discord API degradation).
- **Events / board game:** `/events`, `/events/[slug]` (signups, teams, duo invites,
  leaderboard), `/events/[slug]/board` (3D board: boss/pet/path/tiles), plus the simpler
  `/event/[slug]`.
- **Bingo:** `/bingo/[slug]` (player), `/admin/bingo/[slug]` (tiles + review).
- **Cards:** `/gamba` (3D pack opener + simulator), `/admin/cards`, `/admin/pack-tester`,
  `/admin/pack-sim`, `/admin/pack-stats`, `/admin/crate-sim`.
- **Tasks:** `/tasks/*` (submit proof), `/admin/tasks`, `/admin/submissions` (review).
- **Admin hub** (`/admin`, role-gated, links shown per role): `events`, `moderation`,
  `wallets`, `stats`, `audit`, `guides`, `admins` (owner role management),
  `overview` (read-only config/roster snapshot); **super-admin only:** `config`
  (bot_config editor), `tables/[table]` (generic table editor), `inventory`.

## Admin audit log (`src/lib/server/audit.ts`)

Admin form POSTs are logged automatically from the hook: who (user + roles), where
(route/path/action), the form payload (files reduced to metadata, long fields truncated),
the response status, and — for table edits — the prior row state so the viewer can show a
before→after diff. Stored in `vs_audit_log`.

## Cross-repo coupling (with `volition-discord-bot`)

- **Shared Supabase DB.** Site tables are `vs_`-prefixed to avoid collision; the bot owns
  `players`, `bans`, `bot_config`, and its own game tables.
- **Bot config editor:** `/admin/config` (super-admin) writes `bot_config`; the bot
  hot-reloads within ~60s. This is the seam used by the editable command-messages and
  forms work.
- **Bot bridge:** the site posts to a Discord webhook the bot listens on for actions like
  granting a Discord role after a reward (see `src/lib/server/botBridge.ts`).

## Conventions

- **Svelte 5 runes** (`$state`, `$derived`, `$props`, `{#snippet}`/`{@render}`).
- **Form actions** return `{ ok: true }` or `fail(status, { error })`; forms use
  `use:enhance` for optimistic UI.
- **Styling:** scoped component CSS + global design tokens (CSS variables) in
  `src/app.css` (dark theme, orange accent, self-hosted RS fonts).
- **Server-only** logic stays in `src/lib/server/` so secrets never reach the client.

## Environment variables

Required: `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `DISCORD_CLIENT_ID`,
`DISCORD_CLIENT_SECRET`, `PUBLIC_SITE_URL`, and the role lists `ADMIN_DISCORD_IDS`,
`SUPER_ADMIN_DISCORD_IDS`, `CARD_TESTER_DISCORD_IDS`. Optional bridge/ops webhook URLs may
also be set. Fly injects `NODE_ENV`, `PORT`, `FLY_REGION`. Confirm the live list against
`hooks.server.ts`, `auth.ts`, the `auth/discord/*` routes, and `botBridge.ts`.
