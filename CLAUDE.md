# Volition Site — repository guide

SvelteKit web app for the Volition OSRS clan: Discord-authenticated member portal,
events/bingo/board games, a 3D card "gamba" game, and a role-gated admin area. Shares
one Supabase Postgres database with the Discord bot (`volition-discord-bot`).

**[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)** is the high-level overview and the
index to everything below.

## Keep the docs current (important)

When a change alters how a system works, update the matching topical doc **in the same
commit**. When you add a whole new system, add a doc and a row to the map below (and in
`docs/ARCHITECTURE.md`). Docs that lie are worse than no docs.

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

## Documentation map — look here when…

| You're working on… | Read |
|---|---|
| The whole picture / where a system lives | [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) (overview + index) |
| Supabase, adding a table, RLS/auth posture | [`docs/DATABASE.md`](docs/DATABASE.md) |
| Adding a page / the instant-nav pattern | [`docs/PAGES.md`](docs/PAGES.md) |
| Login, sessions, roles, ban gate, audit | [`docs/AUTH.md`](docs/AUTH.md) |
| UI, wiki images, bingo tiles, styling | [`docs/FRONTEND.md`](docs/FRONTEND.md) |
| Building any event / board / bingo | [`docs/EVENTS.md`](docs/EVENTS.md) |
| Rank scoring, /me rank check, gear claims | [`docs/RANKS.md`](docs/RANKS.md) |
| Site onboarding flow (the `/welcome/[token]` join) | [`docs/ONBOARDING.md`](docs/ONBOARDING.md) |
| The Dink drop-tracking pipeline | [`docs/event-builder-and-dink-tracking.md`](docs/event-builder-and-dink-tracking.md) |
| Deploying / configuring staging | [`docs/DEPLOY-STAGING.md`](docs/DEPLOY-STAGING.md) |
| Outstanding ops (RLS lockdown, prod ship) | [`docs/PENDING-OPS.md`](docs/PENDING-OPS.md) |

## At a glance

- **Stack:** SvelteKit 2 + Svelte 5 (runes), TypeScript, `adapter-node`, Fly.io (Node 22),
  Supabase (`@supabase/supabase-js`, server-side only).
- **Commands:** `npm run dev`, `npm run build`, `npm run check` (svelte-check — run before
  pushing; there is no automated test suite).
- **Non-negotiables:** site tables are `vs_`-prefixed; DB access is server-only
  (`src/lib/server/`); roles come from env allow-lists + `vs_admin_roles` grants; form
  actions use `use:enhance`; styling uses the CSS tokens in `src/app.css`; hand-applied SQL
  lives in `db/scripts/` + `db/functions/` (no migration runner).
