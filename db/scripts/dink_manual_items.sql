-- Manually PINNED Dink tracked items — an event-decoupled way to put a specific item in a
-- member's served Dink allowlist for a while, independent of events/boards. Apply by hand in
-- the Supabase SQL editor (no migration runner). Safe to re-run. Apply BEFORE re-applying
-- active_tiles.sql (branch 4 reads this table).
--
-- Primary use: the /dink-check connection self-test pins Bones for the visiting member with a
-- short, refreshed TTL (this replaces the old fake `dink-self-test` event). Also usable to pin
-- any item to a member's tracking (null expires_at = permanent).
--
-- Expiry is DECLARATIVE: a row counts only while `expires_at is null or expires_at > now()`,
-- so there is no prune job — vs_active_player_tiles (branch 4) simply stops emitting it.

create table if not exists vs_dink_manual_items (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references vs_users(id) on delete cascade,
  item_id     int  not null,
  item_name   text not null,
  match_type  text not null default 'loot',   -- display/intent only; matching watches both ways
  expires_at  timestamptz,                    -- null = permanent pin; else must be in the future
  reason      text,                           -- 'self-test' | 'clan-watch' | admin note
  created_at  timestamptz not null default now()
);

-- One pin per (member, item): re-pinning refreshes the same row (upsert on this constraint).
create unique index if not exists vs_dink_manual_items_user_item on vs_dink_manual_items (user_id, item_id);
create index        if not exists vs_dink_manual_items_user      on vs_dink_manual_items (user_id);
create index        if not exists vs_dink_manual_items_expires   on vs_dink_manual_items (expires_at);

-- RLS lockdown, same posture as every vs_ table (see enable_rls.sql): enable RLS with NO
-- policies so anon/authenticated can read/write nothing; the site reads/writes via
-- service_role (which bypasses RLS).
alter table vs_dink_manual_items enable row level security;
revoke all on vs_dink_manual_items from anon, authenticated;

-- PostgREST caches the schema; without this the new table 404s until reload.
notify pgrst, 'reload schema';
