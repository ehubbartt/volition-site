#!/usr/bin/env bash
set -euo pipefail

# Refresh the STAGING database with a fresh copy of PROD's public schema + data.
# This is a point-in-time snapshot — re-run it whenever you want staging's data
# to match prod again. It is DESTRUCTIVE to staging's public schema (--clean drops
# and recreates those objects) and NEVER writes to prod.
#
# Reads Session-pooler connection strings from the environment (get them from the
# Supabase dashboard → Connect → "Session pooler"; include ?sslmode=require):
#   PROD_DB_URL      prod    (read from)
#   STAGING_DB_URL   staging (written to)
# Optional:
#   PG_BIN=/usr/local/opt/libpq/bin   dir holding a v15+ pg_dump/pg_restore
#                                     (Supabase runs PG 15/17; `brew install libpq`)
#   ASSUME_YES=1                      skip the confirmation prompt
#
# See docs/DEV-PREVIEW.md for the full walkthrough.

: "${PROD_DB_URL:?set PROD_DB_URL to the prod Session-pooler connection string}"
: "${STAGING_DB_URL:?set STAGING_DB_URL to the staging Session-pooler connection string}"

PGDUMP="${PG_BIN:+$PG_BIN/}pg_dump"
PGRESTORE="${PG_BIN:+$PG_BIN/}pg_restore"

# Guard against an old client (the classic macOS/Anaconda v14 pg_dump segfaults
# against Supabase's newer server).
ver="$("$PGDUMP" --version | grep -oE '[0-9]+' | head -1 || true)"
if [ "${ver:-0}" -lt 15 ]; then
	echo "pg_dump is v${ver:-?}; Supabase needs v15+." >&2
	echo "  brew install libpq   # then re-run with: PG_BIN=/usr/local/opt/libpq/bin" >&2
	exit 1
fi

if [ "${ASSUME_YES:-}" != "1" ]; then
	echo "This DROPS and replaces the public schema on STAGING with a copy of PROD."
	printf "Continue? [y/N] "
	read -r ans
	case "$ans" in
		y | Y | yes | YES) ;;
		*) echo "aborted."; exit 1 ;;
	esac
fi

dump="$(mktemp -t volition-prod.XXXXXX)"
trap 'rm -f "$dump"' EXIT

echo "▸ Dumping prod (public schema + data)…"
"$PGDUMP" "$PROD_DB_URL" --schema=public --no-owner --no-privileges -Fc -f "$dump"

echo "▸ Restoring into staging…"
"$PGRESTORE" --clean --if-exists --no-owner --no-privileges -d "$STAGING_DB_URL" "$dump"

# --clean DROPs every object and --no-privileges carries no GRANTs back, so the
# restored tables have no grants to Supabase's API roles. PostgREST then answers
# every request with `42501 permission denied for schema public` — which reads like
# a bad service-role key, but is purely missing grants. Put them back.
echo "▸ Restoring Supabase role grants…"
PSQL="${PG_BIN:+$PG_BIN/}psql"
"$PSQL" "$STAGING_DB_URL" -v ON_ERROR_STOP=1 -q -f "$(dirname "$0")/scripts/restore_supabase_grants.sql"

echo "✓ Staging now mirrors prod. (First-run 'does not exist, skipping' notices are harmless.)"
