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

-- Rollback (emergency only — reopens full anon access):
-- do $$
-- declare r record;
-- begin
--   for r in select tablename from pg_tables where schemaname = 'public' loop
--     execute format('alter table public.%I disable row level security', r.tablename);
--   end loop;
-- end $$;
