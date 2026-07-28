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

echo "✓ Staging now mirrors prod. (First-run 'does not exist, skipping' notices are harmless.)"
