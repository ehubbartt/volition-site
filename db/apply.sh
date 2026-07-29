#!/usr/bin/env bash
set -euo pipefail

# Apply a hand-written SQL script (db/scripts/*.sql or db/functions/*.sql) to the
# prod and/or staging database. Because this project has no migration runner, THIS
# is how a schema change reaches staging: whenever you apply a script to prod, run
# it against staging too (--both does both in one go). The scripts are idempotent
# ("safe to re-run"), so re-applying is harmless.
#
# TWO TRANSPORTS
#   psql  — the Postgres wire protocol over raw TCP (port 5432). Preferred; used
#           whenever the database actually answers on that port.
#   api   — the Supabase Management API over plain HTTPS. Used automatically when
#           raw TCP is blocked, which is the case inside a sandboxed dev container.
#
# Both fail loudly on a bad statement. psql runs with ON_ERROR_STOP so it aborts at
# the first error; the API runs the whole file as one implicit transaction, so a
# failure rolls the entire script back. Either way the script never half-applies
# silently and this program exits non-zero.
#
# ENVIRONMENT
#   PROD_DB_URL, STAGING_DB_URL   Session-pooler connection strings (?sslmode=require)
#   SUPABASE_ACCESS_TOKEN         Supabase personal access token, for the API transport
#
# Optional:
#   SUPABASE_STAGING_REF   staging project ref; derived from STAGING_DB_URL if unset
#   SUPABASE_PROD_REF      prod project ref. REQUIRED to reach prod over the API, and
#                          never derived from anything — see the safety note below.
#   DB_APPLY_VIA           auto (default) | psql | api — force a transport
#   PGCONNECT_TIMEOUT      per-host psql connect timeout in seconds (default 5)
#   PG_BIN                 dir holding a v15+ psql (`brew install libpq`)
#
# SAFETY: the access token is account-scoped — it can reach prod as easily as staging,
# and there is no staging-only Supabase token. So the API transport is staging-only
# unless you deliberately set SUPABASE_PROD_REF. Nothing derives, guesses, or defaults
# the prod ref; without that variable `--prod` over HTTPS refuses to run.
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

die() { echo "$*" >&2; exit 1; }

# Scratch dirs hold the request body and the 0600 curl config; wipe them however we exit.
TMPDIRS=()
cleanup() {
	local d
	# The ${a[@]+"${a[@]}"} dance keeps `set -u` happy on bash 3.2 (macOS's /bin/bash).
	for d in ${TMPDIRS[@]+"${TMPDIRS[@]}"}; do rm -rf "$d"; done
}
trap cleanup EXIT

[ $# -eq 2 ] || { usage; exit 1; }
target="$1"
file="$2"
[ -f "$file" ] || die "no such file: $file"

PSQL="${PG_BIN:+$PG_BIN/}psql"
API_HOST="https://api.supabase.com"
VIA="${DB_APPLY_VIA:-auto}"
case "$VIA" in auto | psql | api) ;; *) die "DB_APPLY_VIA must be auto, psql or api (got: $VIA)" ;; esac

# A Supabase project ref is 20 lowercase alphanumerics. Validate before it reaches a URL.
valid_ref() { [[ "$1" =~ ^[a-z0-9]{20}$ ]]; }

# Pull the project ref out of a pooler URL (user `postgres.<ref>`) or a direct one
# (host `db.<ref>.supabase.co`). Prints nothing when it can't tell.
ref_from_url() {
	local url="$1" ref=""
	[[ "$url" =~ postgres\.([a-z0-9]{20}) ]] && ref="${BASH_REMATCH[1]}"
	[ -n "$ref" ] || { [[ "$url" =~ db\.([a-z0-9]{20})\.supabase\.co ]] && ref="${BASH_REMATCH[1]}"; }
	echo "$ref"
}

# Can we actually open a Postgres connection? A sandboxed container's proxy accepts the
# CONNECT and then resets the stream, so this has to be a real connection attempt, not a
# port check. Cheap `select 1` — anything that fails here means "use the other transport".
psql_reachable() {
	command -v "$PSQL" >/dev/null 2>&1 || return 1
	PGCONNECT_TIMEOUT="${PGCONNECT_TIMEOUT:-5}" "$PSQL" "$1" -tAc 'select 1' >/dev/null 2>&1
}

apply_via_psql() {
	local url="$1"
	# ON_ERROR_STOP so a bad statement fails loudly instead of half-applying.
	"$PSQL" "$url" -v ON_ERROR_STOP=1 -f "$file"
}

# POST the whole file to the Management API's query endpoint. The file goes over as one
# batch, which Postgres wraps in an implicit transaction: every statement lands or none
# does. Statements that can't run inside a transaction (CREATE INDEX CONCURRENTLY, VACUUM)
# therefore need the psql transport.
apply_via_api() {
	local ref="$1" tmp code xtrace=
	# Nothing in this function may be traced — `set -x` would print the token.
	case "$-" in *x*)
		xtrace=1
		set +x
		;;
	esac

	[ -n "${SUPABASE_ACCESS_TOKEN:-}" ] || die "\$SUPABASE_ACCESS_TOKEN is not set — needed to apply over HTTPS"
	case "$SUPABASE_ACCESS_TOKEN" in
	*'"'* | *'\'*) die "\$SUPABASE_ACCESS_TOKEN contains a quote or backslash; refusing to build a curl config from it" ;;
	esac
	command -v node >/dev/null 2>&1 || die "node is required to build the request body"

	tmp="$(mktemp -d)"
	TMPDIRS+=("$tmp")
	(
		umask 077
		# The token lives in a 0600 config file so it never appears in argv or any log.
		printf 'header = "Authorization: Bearer %s"\n' "$SUPABASE_ACCESS_TOKEN" >"$tmp/curl.cfg"
	)

	node -e 'const fs=require("fs");process.stdout.write(JSON.stringify({query:fs.readFileSync(process.argv[1],"utf8")}))' \
		"$file" >"$tmp/body.json"

	code="$(curl -sS --config "$tmp/curl.cfg" \
		-X POST "$API_HOST/v1/projects/$ref/database/query" \
		-H 'Content-Type: application/json' \
		--data-binary "@$tmp/body.json" \
		-o "$tmp/resp.json" -w '%{http_code}')"

	if [ "$code" != "200" ] && [ "$code" != "201" ]; then
		echo "✗ Management API returned HTTP $code" >&2
		node -e 'const fs=require("fs");const t=fs.readFileSync(process.argv[1],"utf8");let m;try{m=JSON.parse(t).message}catch{}process.stderr.write(((m||t).trim())+"\n")' \
			"$tmp/resp.json" || true
		exit 1
	fi

	# Surface trailing rows (a script ending in a select) but stay quiet for plain DDL.
	node -e 'const fs=require("fs");try{const r=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));if(Array.isArray(r)&&r.length)console.log(JSON.stringify(r))}catch{}' \
		"$tmp/resp.json" || true

	if [ -n "$xtrace" ]; then set -x; fi
}

# apply_to <VAR_NAME> <url> <ref> <ref-hint>
apply_to() {
	local name="$1" url="$2" ref="$3" ref_hint="$4" via="$VIA"

	if [ "$via" = auto ]; then
		if [ -n "$url" ] && psql_reachable "$url"; then
			via=psql
		else
			via=api
			[ -n "$url" ] && echo "   ($name is unreachable over TCP — falling back to the Management API)"
		fi
	fi

	if [ "$via" = psql ]; then
		[ -n "$url" ] || die "\$$name is not set"
		echo "── applying $(basename "$file") → $name (psql) ──"
		apply_via_psql "$url"
	else
		[ -n "$ref" ] || die "$ref_hint"
		valid_ref "$ref" || die "'$ref' is not a valid Supabase project ref (20 lowercase alphanumerics)"
		echo "── applying $(basename "$file") → $name (Management API, project $ref) ──"
		apply_via_api "$ref"
	fi
}

apply_prod() {
	# Deliberately asymmetric: the prod ref is never derived from PROD_DB_URL or anything
	# else. Reaching prod over HTTPS takes a conscious, separate act of configuration.
	apply_to PROD_DB_URL "${PROD_DB_URL:-}" "${SUPABASE_PROD_REF:-}" \
		"refusing to touch prod over HTTPS: set \$SUPABASE_PROD_REF explicitly, or run this from a machine with raw TCP to \$PROD_DB_URL"
}

apply_staging() {
	local ref="${SUPABASE_STAGING_REF:-}"
	[ -n "$ref" ] || ref="$(ref_from_url "${STAGING_DB_URL:-}")"
	apply_to STAGING_DB_URL "${STAGING_DB_URL:-}" "$ref" \
		"can't tell which project is staging: set \$SUPABASE_STAGING_REF, or \$STAGING_DB_URL so the ref can be read from it"
}

case "$target" in
--prod) apply_prod ;;
--staging) apply_staging ;;
--both)
	apply_prod
	apply_staging
	;;
*)
	usage
	exit 1
	;;
esac

echo "✓ done."
