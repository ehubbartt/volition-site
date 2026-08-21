# Volition Site — Architecture overview

The high-level shape of the SvelteKit web app, and a map to the topical docs. Pair with
`CLAUDE.md` (conventions + doc map). Update the matching topical doc when you change how a
system works.

## Documentation map

| Topic | Doc | Read it when… |
|---|---|---|
| Data layer & tables | [`DATABASE.md`](DATABASE.md) | you touch Supabase, add a table, or change the auth/RLS posture |
| Building a page | [`PAGES.md`](PAGES.md) | you add a member/admin page or change the instant-nav modules |
| Auth, roles, ban, audit | [`AUTH.md`](AUTH.md) | you touch login, sessions, roles, the ban gate, or audit logging |
| Frontend & shared UI | [`FRONTEND.md`](FRONTEND.md) | you build UI, use wiki images / bingo tiles, or touch styling |
| Events / boards / bingo | [`EVENTS.md`](EVENTS.md) | you build any new event, board, or bingo (the shared spine) |
| Battleship event | [`BATTLESHIP.md`](BATTLESHIP.md) | you touch the draft/placement/battle event where drops become bombs |
| Connect Four event | [`CONNECT4.md`](CONNECT4.md) | you touch the clan-vs-clan event on a shared 25×10 board where drops claim tiles |
| Signup forms | [`SIGNUPS.md`](SIGNUPS.md) | you need a list of people (and answers) before the real event exists |
| Ranks (scoring, checks, gear claims, manual adjustments) | [`RANKS.md`](RANKS.md) | you touch the composite rank formula, /me rank check, rank-sim, manual gear claims, or the staff adjustment/grant escape hatch |
| Dink auto-tracking | [`event-builder-and-dink-tracking.md`](event-builder-and-dink-tracking.md) | you work on the drop-tracking pipeline |
| Live updates | [`LIVE-UPDATES.md`](LIVE-UPDATES.md) | drop crediting latency, the version-poll pattern (`liveVersion.ts` / `live.svelte.ts`), a board shows a tile somebody already won |
| Staging deploy | [`DEPLOY-STAGING.md`](DEPLOY-STAGING.md) | you deploy or configure the staging app |
| Outstanding ops | [`PENDING-OPS.md`](PENDING-OPS.md) | you're picking up the RLS lockdown / prod ship / migrations |

## Stack & runtime

- **SvelteKit 2 / Svelte 5 (runes)**, TypeScript, `@sveltejs/adapter-node` (SSR).
- Runs as a Node server (`node build`) on **Fly.io** (`fly.toml`, `Dockerfile`, Node 22).
- Data layer: **Supabase Postgres** via `@supabase/supabase-js`, server-side only — see
  [`DATABASE.md`](DATABASE.md).
- Other libs: `arctic` (Discord OAuth), `three` (3D cards), `sharp`, `marked`, `zod`.
- `/health` returns JSON and bypasses auth/redirects for Fly's uptime probe.
- Scripts: `npm run dev`, `npm run build`, `npm run check` (svelte-check),
  `npm run test:e2e` (Playwright, specs in `e2e/`), `npm run sim:battleship` (scripted
  end-to-end game). Run `check` before pushing.

## Request lifecycle (`src/hooks.server.ts`)

Every request passes through the handle hook, in order:
1. **Health probe** short-circuit (`/health`).
2. **Canonical-host redirect** — forces one origin in prod so Discord OAuth cookies and the
   callback stay on the same host (avoids "Invalid OAuth state").
3. **Session + cache round** — `readSession()` sets `locals.user`/`sessionId`, and the
   admin-role and bans caches refresh (one parallel round). See [`AUTH.md`](AUTH.md).
4. **Staging lock** (staging only) and **ban check** — banned users → `/banned`.
5. **Audit capture** — for admin POSTs, snapshots the payload + prior row state, then logs
   the result after the response (see [`AUTH.md`](AUTH.md)).

## Cross-repo coupling (with `volition-discord-bot`)

- **Shared Supabase DB.** Site tables are `vs_`-prefixed to avoid collision; the bot owns
  `players`, `bans`, `bot_config`, and its own game tables.
- **Bot config editor:** `/admin/config` (super-admin) writes `bot_config`; the bot
  hot-reloads within ~60s. This is the seam used by the editable command-messages and forms
  work.
- **Bot bridge:** the site posts to a Discord webhook the bot listens on for actions like
  granting a Discord role after a reward (see `src/lib/server/botBridge.ts`).
- **Voice tracking is bot-owned, and keyed by Discord identity.** The bot's 5-minute poll
  writes `voice_activity_log` (one row per tick) and `voice_user_stats` (the running total,
  via an `increment_voice_user_stats` RPC); `/admin/voice` only reads them
  (`src/lib/server/admin/voice.ts`). Both tables key on the **Discord snowflake** and carry
  the **Discord username** — nothing in the pipeline knows an RSN. The panel resolves a
  display name through `players.discord_id → rsn`, which for most members is nothing like
  their Discord name, so every surface carries BOTH names and the search matches RSN,
  Discord name and snowflake alike. Anything that renders only one of them makes members
  unfindable. The "Recent activity" tab is a **global tail of the newest ticks**, so a
  member with time banked but no recent session is legitimately absent from it — their own
  history comes from the per-member drill-down (`buildVoiceUser`, `/api/admin/voice/[userId]`).

## Environment variables

Required: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` (RLS bypass; the app falls back to
`SUPABASE_ANON_KEY` in dev only — with RLS deny-all it reads/writes nothing in prod),
`DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`, `PUBLIC_SITE_URL`, and the role lists
`ADMIN_DISCORD_IDS`, `SUPER_ADMIN_DISCORD_IDS`, `CARD_TESTER_DISCORD_IDS`. Optional
bridge/ops webhook URLs may also be set. Fly injects `NODE_ENV`, `PORT`, `FLY_REGION`.
Confirm the live list against `hooks.server.ts`, `auth.ts`, the `auth/discord/*` routes, and
`botBridge.ts`.
