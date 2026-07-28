# Staging DB & local visual testing

Two related things: how the **staging database** is cloned and kept in sync (most of this
file), and how to **boot the site locally against it and screenshot pages** (last section).

# Staging DB — cloning prod & keeping it in sync

The site (and the Discord bot) run against a single Supabase Postgres. A **staging**
database lets you test data-driven changes without touching prod. This project has **no
migration runner** — schema lives as hand-applied, idempotent SQL in `db/scripts/` +
`db/functions/` — so staging is kept current with two explicit, scriptable steps rather
than automatic sync.

There is **no live mirror** between prod and staging. Staging is a point-in-time copy;
you refresh its data on demand, and you apply each schema change to it yourself.

## One-time setup

1. **Install a current Postgres client** (Supabase runs PG 15/17; the old macOS/Anaconda
   `pg_dump` v14 segfaults against it):
   ```bash
   brew install libpq
   export PG_BIN=/usr/local/opt/libpq/bin   # Apple-Silicon-only brew: /opt/homebrew/opt/libpq/bin
   "$PG_BIN/pg_dump" --version               # expect 15/16/17/18
   ```
2. **Grab both connection strings** from the Supabase dashboard → top-bar **Connect** →
   **Session pooler** (NOT "Direct connection" — that host is IPv6-only and won't resolve
   on most Macs). Do it once on the prod branch and once on the staging branch; each has
   its own password (reset it in the same panel if unknown). Then export them, keeping the
   `?sslmode=require` suffix:
   ```bash
   export PROD_DB_URL="postgresql://postgres.PRODREF:PW@aws-0-REGION.pooler.supabase.com:5432/postgres?sslmode=require"
   export STAGING_DB_URL="postgresql://postgres.STAGEREF:PW@aws-0-REGION.pooler.supabase.com:5432/postgres?sslmode=require"
   ```
   If a password has special characters, URL-encode it:
   `python3 -c "import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1],safe=''))" 'PW'`
   — or just reset it to something alphanumeric.

Keep these exports in the same terminal window (or add them to a gitignored local file you
`source`). **Never commit connection strings.**

## Refresh staging's data from prod

```bash
db/clone-from-prod.sh
```

Dumps prod's `public` schema + data and restores it into staging. It's **destructive to
staging** (drops & recreates public objects) and never writes to prod. Re-run it whenever
you want staging's data to match prod again. First-run `... does not exist, skipping`
notices are harmless. Set `ASSUME_YES=1` to skip the confirmation prompt.

Only `public` is copied — never the Supabase-managed `auth` / `storage` schemas (copying
those can break the project). Staging therefore gets a real copy of member data; fine for
our own clan, just be aware.

### Role grants after a clone

`pg_restore --clean --no-privileges` DROPs every object and brings it back with **no
grants**, so Supabase's API roles lose access to schema `public`. PostgREST then fails
every request with:

```
{"code":"42501","message":"permission denied for schema public"}
```

That reads like a bad service-role key — it isn't; the key is fine and the grants are
gone. Every consumer (site, bot, Dink worker) breaks at once, so **check grants before
you go hunting for a key problem.** `clone-from-prod.sh` now re-applies
[`db/scripts/restore_supabase_grants.sql`](../db/scripts/restore_supabase_grants.sql)
automatically at the end of each restore. On a database cloned before that change, apply
it once by hand:

```bash
db/apply.sh --staging db/scripts/restore_supabase_grants.sql
```

or paste the file into the Supabase dashboard → **SQL Editor** (no local `psql` needed).

## Keep the schema in sync (new tables/columns)

Whenever a `db/scripts/*.sql` (or `db/functions/*.sql`) is applied to prod, apply the same
file to staging:

```bash
db/apply.sh --both db/scripts/your_change.sql   # prod, then staging
# or one at a time:
db/apply.sh --staging db/scripts/your_change.sql
```

Since the scripts are idempotent, you can also re-apply the whole set to staging anytime to
catch it up. (`apply.sh` runs `psql` with `ON_ERROR_STOP`, so a bad statement fails loudly
instead of half-applying.)

### `apply.sh` needs a real machine — it can't run from a sandboxed container

`apply.sh` speaks the Postgres wire protocol over raw TCP (port 5432). That works from a
laptop, but **not from a sandboxed/remote dev container whose egress is limited to HTTPS**,
which is how the hosted coding agents run. There, connections to the pooler hang and then
reset even though DNS resolves and `STAGING_DB_URL` is set correctly — the port is blocked,
not the credentials.

The tell is that port 443 to the same project works while 5432 and 6543 do not:

```bash
# resolves fine, then hangs — the DB port is not reachable
psql "$STAGING_DB_URL" -c 'select 1'
# but the PostgREST API on 443 answers immediately
curl -s -o /dev/null -w '%{http_code}\n' "$SUPABASE_URL/rest/v1/" -H "apikey: $SUPABASE_SERVICE_ROLE_KEY"
```

Don't burn time re-checking the connection string, the password encoding, or the grants when
you see this — none of them are the cause, and no `sslmode`/pooler-host variation gets around
a closed port.

**Apply schema changes from the Supabase dashboard → SQL Editor instead.** Paste the
`db/scripts/*.sql` file and run it; the scripts are idempotent, so this is equivalent to what
`apply.sh` would have done. Everything that talks to Supabase over HTTPS — the dev server,
`npm run test:e2e`, `npm run preview:shots`, and any `SUPABASE_URL`-based row reads and writes
— works normally in these containers. It is only DDL that needs the dashboard.

## Pointing the staging site at the staging DB

The app reads `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` (server-only; see
`src/lib/server/db.ts`). Set those to the **staging** project's values (dashboard →
Settings → **API Keys** for the key, project URL for `SUPABASE_URL`) in the staging
deploy's environment — see [`DEPLOY-STAGING.md`](DEPLOY-STAGING.md). Point the staging bot
at the same DB too, or the bot keeps writing prod.

## Local visual testing against staging

Run the real app on your machine, pointed at the staging DB, signed in as yourself, and
capture PNGs of any page — no Discord OAuth round-trip and no deploy.

### 1. Point your shell at staging

```bash
export SUPABASE_URL="https://<staging-ref>.supabase.co"
export SUPABASE_SERVICE_ROLE_KEY="…"
export SUPER_ADMIN_DISCORD_IDS="<your discord id>"
export PUBLIC_SITE_URL="http://localhost:5173"   # must be loopback — see the gate below
```

`PUBLIC_SITE_URL` has to be the local origin: `hooks.server.ts` 308-redirects every
off-canonical host, so an `https://…` value bounces you straight off localhost.

### 2. The dev-login shortcut

`GET /auth/dev-login?next=/me` mints an ordinary `vs_sessions` row for an existing
`vs_users` row and redirects. The account is `DEV_LOGIN_DISCORD_ID` if set, otherwise the
first id in `SUPER_ADMIN_DISCORD_IDS` — i.e. you.

It **grants no roles of its own.** Roles still resolve the normal way from the env
allow-lists + `vs_admin_roles` (see [`AUTH.md`](AUTH.md)); you come out a super admin only
because your id is already in `SUPER_ADMIN_DISCORD_IDS`. It never creates a user — if the
id has no `vs_users` row you get a 404 saying so, rather than a silently invented account.

**It cannot exist in a deploy.** `src/lib/server/devLogin.ts` ANDs five independent gates,
each sufficient on its own:

| # | Gate | Blocks |
|---|---|---|
| a | `dev` is true | any built bundle — Vite inlines `false`, so `npm run build` dead-code-eliminates the check to `return false` and the route can only 404 in prod *and* staging |
| b | `DEV_LOGIN` is truthy (`1/true/on/yes`) | a plain local `npm run dev`, which has it off by default |
| c | `NODE_ENV` is not `production` | production-mode processes |
| d | no `FLY_APP_NAME` / `FLY_MACHINE_ID` / `FLY_ALLOC_ID` | a dev server started on a Fly machine |
| e | `PUBLIC_SITE_URL` is loopback or unset | anything pointed at a real origin |

Gate (a) is the load-bearing one; (b)–(e) only matter if someone runs `vite dev` on a
server. If you ever need to verify: `npm run build` then read
`.svelte-kit/output/server/entries/endpoints/auth/dev-login/_server.ts.js` — `devLoginEnabled`
should be literally `return false`.

### 3. End-to-end tests

```bash
npm run test:e2e            # headless
npm run test:e2e:ui         # interactive runner
npm run test:e2e:report     # last HTML report
```

Playwright (`@playwright/test`), specs in `e2e/`. `playwright.config.ts` boots `vite dev`
itself (`webServer`), so there is nothing to start by hand — just have the staging env vars
exported. `e2e/auth.setup.ts` runs first, signs in through dev-login once, and saves the
session to `e2e/.auth/user.json`; every other spec starts from that state.

Notes on how it's wired:

- **The browser is the one already on disk.** Playwright pins a Chromium revision it would
  normally download; the config points `executablePath` at whatever `chromium-*` build sits
  under `PLAYWRIGHT_BROWSERS_PATH` instead (override with `CHROMIUM_PATH`). Revisions don't
  need to match — this image ships 1194 and drives fine under the 1234 Playwright expects.
  So **never run `npx playwright install`**; nothing needs downloading.
- **It is not in the production image.** `@playwright/test` is a devDependency with no
  install script, so `npm ci --include=dev` in the Dockerfile's build stage costs a few MB
  and downloads no browsers, and `npm prune --omit=dev` strips it before the final stage.
- **One worker, no parallelism.** These run against a shared database; parallel writes
  across workers would race.
- **One retry by default.** `readSession` fails *closed*, so a transient Supabase read
  signs a request out and redirects it exactly like a real auth failure.

Assert on *data*, not just on rendering. A page that renders perfectly with everything
empty is precisely what a broken DB connection produces, and a render-only check sails
straight past it — see `e2e/smoke.spec.ts`.

One gotcha worth knowing before writing selectors: controls that hide their real input and
style the surrounding `<label>` instead. If the input is `display: none` it is gone from the
accessibility tree entirely — `getByRole` can't see it, and neither keyboard nor screen
reader can operate it. That's a bug to fix, not to work around (the `/me` theme picker used
to do this). The correct pattern is visually-hidden-but-focusable (1px + `clip-path`), which
`getByRole` *can* find — but it still isn't clickable, so `.check()` times out waiting for
visibility. Drive those the way a keyboard user does: `.focus()` then `Space`.

### 4. Screenshot pages

```bash
npm run preview:shots -- / /me
```

`scripts/preview.mjs` boots `vite dev`, signs in via dev-login, and captures each page into
`preview-shots/` (gitignored). It is only the camera — for clicking, filling forms, or
asserting anything, write a spec in `e2e/` instead.

```
--no-login        skip dev-login and shoot the signed-out site
--out DIR         output directory (default preview-shots)
--port N          dev-server port (default 5173)
--width/--height  viewport (default 1440x900)
--full-page       whole scroll height instead of the viewport
```

Viewport capture is the default because full-page on a list-heavy page is rarely useful —
the signed-in home page runs to ~19,000px of member table, an unreadable strip.

It warns `⚠ THIS IS /x, not /y` when a page redirects somewhere other than what you asked
for, so a shot is never silently the wrong page.

### Troubleshooting

Pages render correctly but come up **empty** — right shell, right styling, no data. That
is always the DB connection, and it's quiet because the pages fetch their data after
hydration. Check it directly:

```bash
curl -s "$SUPABASE_URL/rest/v1/vs_users?select=discord_id&limit=1" \
  -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY"
```

| Symptom | Cause |
|---|---|
| `403 Host not in allowlist` | sandboxed egress policy — add `<ref>.supabase.co` to it |
| `42501 permission denied for schema public` | the grants a clone wiped — see § Role grants after a clone |
| curl works but the dev server still can't connect | Node's `fetch` (what supabase-js uses) ignores `HTTPS_PROXY` unless `NODE_USE_ENV_PROXY=1`, so it goes direct and gets refused while curl succeeds. `preview.mjs` sets this for the dev server whenever a proxy is configured; set it yourself for a bare `npm run dev` behind one |
| `psql` / `db/apply.sh` hangs, then resets | the DB port isn't reachable from a sandboxed container — see § `apply.sh` needs a real machine |

#### An unexplained signed-out run

While this harness was being built, roughly **1 run in 4** came up signed out: the home page
rendered its logged-out state and `/me` bounced to `/`. It correlated with freshly booted
`vite dev` servers and was consistent for a whole run rather than flickering per request.

The root cause was never found. Ruled out: a bad service-role key, missing grants, the egress
proxy, navigation timing in the specs, and a stale server holding the port. Two changes
partly cover it — `readSession` no longer treats a failed lookup as "no such session" (it
retries once and keeps the cache), and the Playwright config retries once — and it has not
recurred since, including on a cold container. It was never explained, though, so if you see
it again treat it as a real lead rather than flakiness.

To confirm the key itself is a live service-role key, decode its claims (it's a JWT):

```bash
node -e "console.log(JSON.parse(Buffer.from(process.env.SUPABASE_SERVICE_ROLE_KEY.split('.')[1],'base64url')))"
```

Expect `role: "service_role"`, a matching `ref`, and an `exp` in the future.
