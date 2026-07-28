-- Restore the Supabase role grants on schema public. Idempotent — safe to re-run.
--
-- WHY THIS EXISTS
-- `db/clone-from-prod.sh` restores with `pg_restore --clean --no-privileges`: --clean
-- DROPs every object in staging's public schema, and --no-privileges means the dump
-- carries no GRANT statements to put back. The objects return owned by the restoring
-- role with NO grants to Supabase's API roles, so PostgREST — which connects as
-- `authenticator` and SETs ROLE to the role in the JWT — loses access to everything:
--
--     {"code":"42501","message":"permission denied for schema public"}
--
-- The key is fine; the grants are gone. Every consumer breaks at once (site, bot,
-- Dink worker) with an error that reads like a bad key, so check grants first.
-- clone-from-prod.sh now applies this automatically after each restore; run it by
-- hand against any database that predates that change:
--
--     db/apply.sh --staging db/scripts/restore_supabase_grants.sql
--
-- or paste it into the Supabase dashboard → SQL Editor (no local psql needed).

-- ---------------------------------------------------------------------------
-- 1. Schema access. USAGE alone exposes nothing — it only lets a role reach
--    objects it has been granted separately.
-- ---------------------------------------------------------------------------
grant usage on schema public to postgres, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. The grants the servers actually need. Everything that talks to this
--    database — site, bot, Dink worker — is server-side and uses the
--    service-role key (see docs/DATABASE.md), so this is what unbreaks the app.
--    service_role also bypasses RLS, which is the real authorization boundary.
-- ---------------------------------------------------------------------------
grant all on all tables in schema public to postgres, service_role;
grant all on all sequences in schema public to postgres, service_role;
grant all on all routines in schema public to postgres, service_role;

-- Future objects, so a later CREATE TABLE doesn't reintroduce the same breakage.
alter default privileges in schema public grant all on tables to postgres, service_role;
alter default privileges in schema public grant all on sequences to postgres, service_role;
alter default privileges in schema public grant all on routines to postgres, service_role;

-- ---------------------------------------------------------------------------
-- 3. OPTIONAL — the anon/authenticated grants Supabase ships by default.
--
--    DELIBERATELY LEFT OUT of the block above. Nothing in this project queries
--    Supabase from a browser, so no consumer needs them; leaving them off means a
--    leaked anon/publishable key reads nothing even on a database where the RLS
--    lockdown (db/scripts/enable_rls.sql, docs/PENDING-OPS.md §1) has not been run
--    yet. That is the safer default for a freshly cloned staging DB, which holds a
--    real copy of member data.
--
--    Uncomment ONLY to match stock Supabase defaults, and only once RLS deny-all is
--    on — otherwise this opens every table to the anon key.
-- ---------------------------------------------------------------------------
-- grant all on all tables in schema public to anon, authenticated;
-- grant all on all sequences in schema public to anon, authenticated;
-- grant all on all routines in schema public to anon, authenticated;
-- alter default privileges in schema public grant all on tables to anon, authenticated;
-- alter default privileges in schema public grant all on sequences to anon, authenticated;
-- alter default privileges in schema public grant all on routines to anon, authenticated;
