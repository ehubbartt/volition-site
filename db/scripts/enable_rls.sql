-- Deny-all lockdown: enable Row-Level Security on every table in the public
-- schema, with NO policies on purpose. Nothing browser-side ever queries
-- Supabase — the site, the bot, and the Dink proxy Worker are all server-side
-- and use the service-role key, which bypasses RLS entirely. With RLS on and
-- zero policies, the anon key (Supabase's publishable key) can read/write
-- NOTHING via PostgREST, which closes the "rls_disabled_in_public" linter
-- warning and makes an anon-key leak harmless.
--
-- ORDER MATTERS: only run this after every consumer has the service-role key
-- deployed (site prod + staging Fly secrets, bot Fly secret, the Cloudflare
-- Dink Worker's SUPABASE_KEY wrangler secret). Enabling RLS first breaks them.
--
-- Canary first (instantly reversible per table):
--   alter table public.wordles enable row level security;
--   -- verify site/bot/dink still work, then run the block below.

do $$
declare r record;
begin
  for r in select tablename from pg_tables where schemaname = 'public' loop
    execute format('alter table public.%I enable row level security', r.tablename);
  end loop;
end $$;

-- Views execute with the OWNER's privileges by default, and the owner is exempt
-- from RLS on its own tables — so a plain view (vs_active_player_tiles,
-- vs_active_participants, vs_active_tracked_items) would keep leaking to anon
-- even with every table locked. security_invoker makes each view honor the
-- CALLER's RLS; the revoke is belt-and-braces. Looping pg_views also covers any
-- legacy hand-applied views that no longer live in this repo. The site, bot,
-- and Dink worker keep reading these views unchanged (service_role bypasses RLS).
do $$
declare r record;
begin
  for r in select viewname from pg_views where schemaname = 'public' loop
    execute format('alter view public.%I set (security_invoker = true)', r.viewname);
    execute format('revoke select on public.%I from anon, authenticated', r.viewname);
  end loop;
end $$;

-- PostgREST exposes every public-schema function at /rest/v1/rpc/<name>, and
-- Postgres grants EXECUTE to PUBLIC by default — so an anonymous caller could
-- still run SECURITY DEFINER helpers (which bypass RLS) or schema-introspection
-- functions (get_public_tables / get_column_info) after the table lockdown.
-- Deny anon/PUBLIC; service_role needs its own grant once PUBLIC is revoked or
-- every .rpc() call from the site/bot breaks.
revoke execute on all functions in schema public from public, anon, authenticated;
alter default privileges in schema public revoke execute on functions from public;
grant execute on all functions in schema public to service_role;
alter default privileges in schema public grant execute on functions to service_role;

-- Verify afterwards (all three must be denied/empty with the ANON key):
--   /rest/v1/players?select=rsn&limit=1            -> []
--   /rest/v1/vs_active_participants?select=*       -> permission denied
--   /rest/v1/rpc/get_public_tables                 -> permission denied
-- And eyeball which definer functions exist in the live DB:
--   select proname, prosecdef from pg_proc p
--     join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public';

-- Rollback (emergency only — reopens full anon access):
-- do $$
-- declare r record;
-- begin
--   for r in select tablename from pg_tables where schemaname = 'public' loop
--     execute format('alter table public.%I disable row level security', r.tablename);
--   end loop;
-- end $$;
