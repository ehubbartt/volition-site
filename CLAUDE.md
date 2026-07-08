# Volition Site — repository guide

SvelteKit web app for the Volition OSRS clan: Discord-authenticated member portal,
events/bingo/board games, a 3D card "gamba" game, and a role-gated admin area. Shares
one Supabase Postgres database with the Discord bot (`volition-discord-bot`).

For the full picture — systems, data flow, tables, deployment — see
**[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)**. Keep that file current when you
change how a system works.

## Authoring & naming conventions (important)

The maintainer does **not** want "Claude" — or any AI/model name — surfaced in this
repository or its Git/GitHub history. Apply this in **every** session:

- **Commit author/committer:** use the maintainer's git identity
  (`Ethan Hubbartt <ehubbartt@gmail.com>`). Never author or co-author commits as
  "Claude", "Anthropic", or any model name.
- **No attribution trailers:** do not add `Co-Authored-By: Claude`,
  `🤖 Generated with Claude Code`, `Claude-Session`, or similar lines to commit
  messages or PR bodies. `.claude/settings.json` disables these automatically —
  leave it in place.
- **Branch names:** topical names that describe the feature
  (e.g. `admin-access-management`, `config-write-hardening`). Never include "claude".
- **PR titles & bodies:** describe the change only — no "Claude"/AI mentions.
- **Code, comments, and docs:** no "Claude"/AI mentions anywhere in committed content.

The only exception is this `CLAUDE.md` file and the `.claude/` directory themselves,
whose names are fixed by the tooling that loads them.

## Delivery notes

- One topical branch + one PR per feature; keep PRs free of merge conflicts.
- Don't push to someone else's branch — open a PR instead.

## Quick orientation

- **Stack:** SvelteKit 2 + Svelte 5 (runes), TypeScript, `adapter-node`, deployed on
  Fly.io (Node 22). Data via Supabase (`@supabase/supabase-js`).
- **Commands:** `npm run dev` (Vite), `npm run build`, `npm run check` (svelte-check —
  run before pushing; there is no automated test suite).
- **Where things live:**
  - `src/routes/` — pages & form actions (filesystem routing). `admin/` is the
    role-gated area; `auth/` is Discord OAuth; public event/bingo/gamba pages.
  - `src/lib/server/` — server-only code: `auth.ts` (sessions + roles), `db.ts`
    (Supabase client + pagination helpers), `audit.ts` (admin audit log),
    `adminRoles.ts` (DB-backed role cache).
  - `src/lib/` — shared components/utilities (Svelte 5).
  - `src/hooks.server.ts` — per-request middleware: canonical-host redirect, session
    load, ban check, admin-role cache refresh, audit capture.
  - `db/scripts/`, `db/functions/` — hand-applied SQL (no migration runner).
- **Conventions:** site-owned tables are prefixed **`vs_`**; roles come from env
  allow-lists (`ADMIN_DISCORD_IDS`, `SUPER_ADMIN_DISCORD_IDS`,
  `CARD_TESTER_DISCORD_IDS`) plus DB grants in `vs_admin_roles`; form actions use
  `use:enhance`; styling uses the CSS-variable tokens in `src/app.css`.
- **Env vars:** `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` (RLS is deny-all;
  `SUPABASE_ANON_KEY` is a dev-only fallback), `DISCORD_CLIENT_ID`,
  `DISCORD_CLIENT_SECRET`, `PUBLIC_SITE_URL`, the three `*_DISCORD_IDS` lists. See
  `docs/ARCHITECTURE.md` for the complete list.
