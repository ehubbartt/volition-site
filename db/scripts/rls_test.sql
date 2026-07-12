-- RLS TEST SCAFFOLD — a disposable table/view/function to prove the deny-all
-- lockdown works on STAGING before running the real db/scripts/enable_rls.sql on
-- the shared prod DB. Everything here is throwaway (vs_rls_test*) and carries no
-- real data. Run the three sections in order; watch /admin/rls-test (staging,
-- admin-only) flip; then run CLEANUP.
--
-- This mirrors all THREE mechanisms enable_rls.sql uses: table RLS, a
-- security_invoker view, and a function EXECUTE revoke.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- SECTION 1 — SETUP (run first). Creates the objects + one sentinel row.
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.vs_rls_test (
	id bigint generated always as identity primary key,
	note text
);

insert into public.vs_rls_test (note)
select 'rls test row — safe to delete'
where not exists (select 1 from public.vs_rls_test);

create or replace view public.vs_rls_test_view as
	select id, note from public.vs_rls_test;

create or replace function public.vs_rls_test_fn() returns text
	language sql stable as $$ select 'rls test fn ok'::text $$;

-- Tell PostgREST (the REST API supabase-js talks to) about the NEW objects — it
-- caches the schema, so without this the API reports "not found in the schema
-- cache" for a few seconds/minutes. Only needed for newly-created objects; the
-- real enable_rls.sql acts on existing tables, so it needs no reload.
notify pgrst, 'reload schema';

-- After SECTION 1: visit /admin/rls-test on staging → all three READABLE (RLS off).

-- ─────────────────────────────────────────────────────────────────────────────
-- SECTION 2 — ENABLE the lockdown (run to lock the test objects down).
-- ─────────────────────────────────────────────────────────────────────────────
-- Table: RLS on with NO policy = deny-all for anon/authenticated.
alter table public.vs_rls_test enable row level security;

-- View: plain views run with the OWNER's rights (exempt from the table's RLS), so
-- security_invoker + a revoke is what actually blocks anon.
alter view public.vs_rls_test_view set (security_invoker = true);
revoke select on public.vs_rls_test_view from anon, authenticated;

-- Function: EXECUTE is granted to PUBLIC by default; revoke it and re-grant only
-- to service_role (so the app's service-key client still works).
revoke execute on function public.vs_rls_test_fn() from public, anon, authenticated;
grant execute on function public.vs_rls_test_fn() to service_role;

-- After SECTION 2, refresh /admin/rls-test:
--   • app on the ANON key   → table 0 rows, view denied, rpc denied  (RLS blocks anon ✔)
--   • app on the SERVICE key → all readable                          (service bypasses ✔)
--
-- Optionally verify the EXTERNAL anon path from your machine (all must be denied/empty).
-- Replace <ANON_KEY> with the project's anon key:
--   curl "https://rrnmckaabbvtkkpoeefg.supabase.co/rest/v1/vs_rls_test?select=*" \
--     -H "apikey: <ANON_KEY>" -H "authorization: Bearer <ANON_KEY>"          # → []
--   curl "https://rrnmckaabbvtkkpoeefg.supabase.co/rest/v1/vs_rls_test_view?select=*" \
--     -H "apikey: <ANON_KEY>" -H "authorization: Bearer <ANON_KEY>"          # → permission denied
--   curl -X POST "https://rrnmckaabbvtkkpoeefg.supabase.co/rest/v1/rpc/vs_rls_test_fn" \
--     -H "apikey: <ANON_KEY>" -H "authorization: Bearer <ANON_KEY>"          # → permission denied

-- ─────────────────────────────────────────────────────────────────────────────
-- SECTION 3 — CLEANUP (run when done). Removes everything.
-- ─────────────────────────────────────────────────────────────────────────────
-- drop view if exists public.vs_rls_test_view;
-- drop function if exists public.vs_rls_test_fn();
-- drop table if exists public.vs_rls_test;
