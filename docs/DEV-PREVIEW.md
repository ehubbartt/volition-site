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

## Pointing the staging site at the staging DB

The app reads `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` (server-only; see
`src/lib/server/db.ts`). Set those to the **staging** project's values (dashboard →
Settings → **API Keys** for the key, project URL for `SUPABASE_URL`) in the staging
deploy's environment — see [`DEPLOY-STAGING.md`](DEPLOY-STAGING.md). Point the staging bot
at the same DB too, or the bot keeps writing prod.
