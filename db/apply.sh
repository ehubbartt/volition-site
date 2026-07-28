#!/usr/bin/env bash
set -euo pipefail

# Apply a hand-written SQL script (db/scripts/*.sql or db/functions/*.sql) to the
# prod and/or staging database. Because this project has no migration runner, THIS
# is how a schema change reaches staging: whenever you apply a script to prod, run
# it against staging too (--both does both in one go). The scripts are idempotent
# ("safe to re-run"), so re-applying is harmless.
#
# Reads Session-pooler connection strings from the environment (include ?sslmode=require):
#   PROD_DB_URL, STAGING_DB_URL
# Optional:
#   PG_BIN=/usr/local/opt/libpq/bin   dir holding a v15+ psql (`brew install libpq`)
#
# See docs/DEV-PREVIEW.md for the full walkthrough.

usage() {
	cat <<'EOF'
usage:
  db/apply.sh --prod     <file.sql>
  db/apply.sh --staging  <file.sql>
  db/apply.sh --both     <file.sql>
EOF
}

[ $# -eq 2 ] || { usage; exit 1; }
target="$1"
file="$2"
[ -f "$file" ] || { echo "no such file: $file" >&2; exit 1; }

PSQL="${PG_BIN:+$PG_BIN/}psql"

apply_to() {
	local name="$1" url="$2"
	[ -n "$url" ] || { echo "\$$name is not set" >&2; exit 1; }
	echo "── applying $(basename "$file") → $name ──"
	# ON_ERROR_STOP so a bad statement fails loudly instead of half-applying.
	"$PSQL" "$url" -v ON_ERROR_STOP=1 -f "$file"
}

case "$target" in
	--prod) apply_to PROD_DB_URL "${PROD_DB_URL:-}" ;;
	--staging) apply_to STAGING_DB_URL "${STAGING_DB_URL:-}" ;;
	--both)
		apply_to PROD_DB_URL "${PROD_DB_URL:-}"
		apply_to STAGING_DB_URL "${STAGING_DB_URL:-}"
		;;
	*) usage; exit 1 ;;
esac

echo "✓ done."
