# Spinning up a separate staging / test Fly app

A second Fly app (`volition-site-staging`) that runs the same code as production but on
its own URL, so you can test changes (e.g. the personal collection-log boards + the
unified Dink active-tiles index) without touching the live `volition-site` app. It uses
`fly.staging.toml` and the same `Dockerfile`.

> **One-time cost:** it's a `shared-cpu-1x` / 512 MB machine that suspends when idle
> (`min_machines_running = 0`), so it's nearly free between tests.

## Option A — deploy from your phone via GitHub Actions (recommended, no local CLI)

`.github/workflows/deploy-staging.yml` deploys this app on Fly's **remote builders**, so
you never run `flyctl` locally. Everything below is doable from a phone browser, and **no
secret ever touches this chat or the repo**:

1. **Fly web dashboard** (fly.io) → create app **`volition-site-staging`**, then set its
   secrets under the app's *Secrets* tab — the same list as the CLI step below, with
   `PUBLIC_SITE_URL = https://volition-site-staging.fly.dev`.
2. **Fly dashboard → Account → Access Tokens** → create a token.
3. **GitHub → repo Settings → Secrets and variables → Actions** → add a secret named
   **`FLY_API_TOKEN`** with that token.
4. Trigger a deploy: push to `voli-site-2.0-refactor`, or use the workflow's **Run
   workflow** button (Actions tab). The first auto-run before step 3 will fail with a
   clear "FLY_API_TOKEN not set" message — just add the secret and re-run.
5. Still required (also phone-doable): add the Discord redirect URI (below) and apply the
   SQL (below) in the Supabase web SQL editor.

## Option B — deploy from a computer with flyctl

### What you need (only you can supply these)

1. **Fly auth** — `flyctl` logged in (`fly auth login`) or a deploy token
   (`fly tokens create deploy`).
2. **The app secrets** — the same values prod uses (Supabase keys, Discord app
   credentials, role allow-lists). These are write-only on Fly; copy them from your
   password manager / the prod app's config.
3. **Discord OAuth redirect URI** — add
   `https://volition-site-staging.fly.dev/auth/discord/callback` to your Discord
   application's **OAuth2 → Redirects** list. Login will 400 without it.
4. **Apply the new SQL** to whatever Supabase this points at (see step 4 below).

## Steps

```sh
# 1. Create the app (no machines yet)
fly apps create volition-site-staging

# 2. Set its secrets. PUBLIC_SITE_URL MUST be the staging URL (drives the canonical-host
#    guard + the Discord OAuth callback). Reuse prod values for the rest.
fly secrets set -a volition-site-staging \
  SUPABASE_URL='https://<project>.supabase.co' \
  SUPABASE_ANON_KEY='<anon key>' \
  DISCORD_CLIENT_ID='<client id>' \
  DISCORD_CLIENT_SECRET='<client secret>' \
  PUBLIC_SITE_URL='https://volition-site-staging.fly.dev' \
  ADMIN_DISCORD_IDS='<comma list>' \
  SUPER_ADMIN_DISCORD_IDS='<comma list>' \
  CARD_TESTER_DISCORD_IDS='<comma list>' \
  DINK_PROCESS_SECRET='<any secret>' \
  PROXY_BASE_URL='https://dink-proxy.<account>.workers.dev'

# 3. Deploy (uses fly.staging.toml + the shared Dockerfile)
fly deploy -c fly.staging.toml

# 4. Apply the new hand-run SQL in the Supabase SQL editor (if not already applied to
#    the DB this app points at):
#      db/scripts/personal_boards.sql
#      db/scripts/active_tiles.sql
#      db/scripts/dink_tracking_hardening.sql   (if not already on this DB)
```

Then open `https://volition-site-staging.fly.dev`, log in with Discord, and try
`/clog-bingo` (personal boards) and `/admin/dink-test` (drop simulator).

## Important notes

- **Shared database.** With the default (prod) `SUPABASE_*`, the staging app reads and
  **writes the same tables as prod** — convenient (real clog/event data to test against)
  but personal-board rows and any auto-credits it makes are real. The new schema is
  additive (`vs_personal_board*`, the `vs_active_player_tiles` view), so it won't disturb
  existing tables. If you'd rather isolate, point `SUPABASE_*` at a separate Supabase
  project and re-run all of `db/` against it (it'll start with no data).
- **Keep test traffic out of Discord channels.** Do **not** set the webhook secrets
  (`DISCORD_BINGO_WEBHOOK_URL`, `DISCORD_DROPS_WEBHOOK_URL`, `DISCORD_OPS_WEBHOOK_URL`,
  `DISCORD_BOT_BRIDGE_WEBHOOK_URL`) on staging — leaving them unset makes those posts
  no-op, so testing a tile credit won't announce to the real clan. Set them only if you
  want to test the announcements (ideally pointed at a throwaway webhook).
- **Admin-only lock.** `fly.staging.toml` sets `STAGING_ADMIN_ONLY = 'true'`, so the whole
  staging site is gated behind admin sign-in (env allow-lists + `vs_admin_roles` grants) —
  non-admins get a "restricted to admins" notice; the Discord auth flow and `/health` stay
  open. Prod never sets this var, so prod is unaffected. To open staging to everyone, set it to
  `'false'` (or remove it) and redeploy.
- **`FLY_MACHINE_ID` / `FLY_REGION`** are injected by Fly automatically — don't set them.
- **Tear down** when done: `fly apps destroy volition-site-staging`.
