-- Unified per-player ACTIVE-TILES index. Apply by hand in the Supabase SQL editor
-- (no migration runner). Safe to re-run.
--
-- `vs_active_player_tiles` is a LIVE VIEW: one row per (player, tile) the player can
-- currently complete, across all OPEN, already-STARTED events plus their personal
-- collection-log board, plus any manually-PINNED items (branch 4 — e.g. the connection
-- self-test; see vs_dink_manual_items in dink_manual_items.sql, which must be applied
-- first). Each row carries a `type` discriminator — 'item' tiles are auto-trackable by
-- Dink (carry item_id + match_type); 'manual' tiles are proof-submission only. A separate
-- `kind` marks 'event' / 'personal' / 'pin' rows; the credit consumer skips 'pin' rows.
--
-- Being a view it is always fresh: a closed event, a completed tile, or a regenerated
-- board makes rows appear/disappear automatically — no triggers, no refresh job, no
-- staleness. The Dink consumer reads only `type='item'`; the proxy allowlist views below
-- derive from the same source so new events/boards plug in with no other changes.
--
-- ACTIVATION RULE (enforced in the consumer, not the view): a drop credits a tile only
-- if drop.received_at >= activated_at. `activated_at` = the event's start for event tiles
-- (the per-row release timing gate refines it), and the board's created_at for personal
-- tiles. No retroactive credit for drops obtained before the tile was active.

-- Prerequisite columns on vs_event_tracked_items. These ship in the hand-applied
-- event_builder.sql, but older databases predate them and both this view and the 2.0
-- event builder require them. Additive + idempotent; existing rows get sensible defaults.
alter table vs_event_tracked_items add column if not exists match_type   text not null default 'loot';
alter table vs_event_tracked_items add column if not exists required_qty int  not null default 1;
alter table vs_event_tracked_items add column if not exists source_name  text;

create or replace view vs_active_player_tiles as
-- (1) Event ITEM tiles: each signed-up user × the tile's tracked item(s). One row per
--     tracked item id so Dink can match by id. Excludes tiles the user already completed.
select s.user_id, u.rsn,
       'event'::text as kind, 'item'::text as type,
       ti.event_id, ti.tile_id,
       null::uuid as board_id, null::int as board_idx,
       te.name as tile_name,
       ti.item_id, ti.item_name,
       coalesce(ti.match_type, 'loot') as match_type,
       coalesce(ti.required_qty, 1)    as required_qty,
       e.starts_at as activated_at
from vs_event_tracked_items ti
join vs_events        e on e.id = ti.event_id and e.status = 'open'
                       and (e.starts_at is null or e.starts_at <= now())
join vs_event_signups s on s.event_id = ti.event_id
join vs_users         u on u.id = s.user_id
left join vs_event_tiles te on te.event_id = ti.event_id and te.tile_id = ti.tile_id
where not exists (
  select 1 from vs_bingo_completions c
  where c.event_id = ti.event_id and c.user_id = s.user_id
    and c.tile_id = ti.tile_id and c.status = 'approved')
union all
-- (2) Event NON-ITEM tiles: signed-up user × event tiles with NO tracked item (manual
--     proof). Represented for completeness; the Dink consumer ignores type<>'item'.
select s.user_id, u.rsn,
       'event'::text, 'manual'::text,
       te.event_id, te.tile_id,
       null::uuid, null::int,
       te.name,
       null::int, null::text, null::text, null::int,
       e.starts_at
from vs_event_tiles te
join vs_events        e on e.id = te.event_id and e.status = 'open'
                       and (e.starts_at is null or e.starts_at <= now())
join vs_event_signups s on s.event_id = te.event_id
join vs_users         u on u.id = s.user_id
where not exists (select 1 from vs_event_tracked_items ti
                  where ti.event_id = te.event_id and ti.tile_id = te.tile_id)
  and not exists (select 1 from vs_bingo_completions c
                  where c.event_id = te.event_id and c.user_id = s.user_id
                    and c.tile_id = te.tile_id and c.status = 'approved')
union all
-- (3) Personal collection-log board tiles. Personal boards are now vs_events rows
--     (kind='personal', owner_user_id set) whose tiles live in vs_tiles; completion is derived
--     from the vs_submissions ledger (no `obtained` column). Only LOCKED boards are tracked; the
--     activation time is the LOCK time (structure->>'rsn' carries the board's RSN). `board_id` =
--     the event id and `board_idx` = the tile position, so the Dink `p:<id>:<idx>` marker is
--     unchanged. Only item tiles with an item_id are Dink-trackable; skill/ca are WoM/WikiSync.
--     match_type comes from tile meta so a tile can opt into plain-loot matching (the admin
--     test board uses this for bones/feather-style drops); normal clog tiles omit it and
--     default to 'collection'.
select e.owner_user_id, (e.structure->>'rsn'),
       'personal'::text, 'item'::text,
       null::uuid, null::text,
       e.id, t.position,
       t.name,
       (t.meta->>'item_id')::int, t.name, coalesce(t.meta->>'match_type', 'collection'), 1,
       e.locked_at
from vs_tiles t
join vs_events e on e.id = t.event_id
where e.kind = 'personal' and e.locked_at is not null
  and t.kind = 'item' and (t.meta->>'item_id') is not null
  and not exists (
    select 1 from vs_submissions s
    where s.event_id = e.id and s.target_id = t.tile_key
      and s.user_id = e.owner_user_id and s.status = 'approved')
union all
-- (4) Manually PINNED tracked items — event-decoupled (vs_dink_manual_items). These exist
--     ONLY to put an item in a member's served allowlist + their rsn in vs_active_participants
--     (e.g. the connection self-test pins Bones); they are NOT a completable tile.
--     `kind='pin'` marks them so the credit consumer excludes them (see dinkAllowlist.ts
--     getTrackedItemsForUser) — they must never reach creditEvent (null event_id). `type='item'`
--     so they flow through vs_dink_token_items / vs_active_tracked_items like any tracked item.
--     Expiry is DECLARATIVE (expires_at null = permanent, else must be in the future) — no prune
--     job, no visit-driven cleanup. activated_at = created_at.
select m.user_id, u.rsn,
       'pin'::text, 'item'::text,
       null::uuid, null::text,
       null::uuid, null::int,
       m.item_name,
       m.item_id, m.item_name, coalesce(m.match_type, 'loot'), 1,
       m.created_at
from vs_dink_manual_items m
join vs_users u on u.id = m.user_id
where m.expires_at is null or m.expires_at > now();

-- Proxy record-allowlist views, derived from the item subset (one source of truth so a
-- new event/board automatically enters the proxy allowlist). The dink-proxy Worker reads
-- these by NAME — verify the exact columns it selects before applying.
--
-- These views may already exist (older event_builder.sql) with a WIDER column shape;
-- `create or replace view` can't drop columns, so drop them first to recreate cleanly.
-- Safe: nothing in the DB depends on them (only the external proxy reads them by name),
-- and they're recreated immediately below.
drop view if exists vs_active_participants;
drop view if exists vs_active_tracked_items;

create view vs_active_participants as
  select distinct lower(rsn) as rsn
  from vs_active_player_tiles
  where rsn is not null;

create view vs_active_tracked_items as
  select distinct item_id, item_name, match_type
  from vs_active_player_tiles
  where type = 'item';

-- Keep the RLS lockdown intact across re-applies (see enable_rls.sql): plain views
-- run with the OWNER's privileges and would leak through table RLS without this.
-- Consumers are unaffected — the site/bot/Dink proxy read via service_role.
alter view vs_active_player_tiles  set (security_invoker = true);
alter view vs_active_participants  set (security_invoker = true);
alter view vs_active_tracked_items set (security_invoker = true);
revoke select on vs_active_player_tiles, vs_active_participants, vs_active_tracked_items
  from anon, authenticated;

-- Supporting indexes (the view is filtered by user_id in the consumer).
create index if not exists vs_event_signups_user      on vs_event_signups (user_id);
create index if not exists vs_event_signups_event     on vs_event_signups (event_id);
create index if not exists vs_event_tracked_items_evt on vs_event_tracked_items (event_id, tile_id);
create index if not exists vs_event_tiles_evt         on vs_event_tiles (event_id, tile_id);
create index if not exists vs_bingo_completions_ut    on vs_bingo_completions (user_id, event_id, tile_id);
create index if not exists vs_tiles_event_kind         on vs_tiles (event_id, kind);
-- Personal-board completion is derived from vs_submissions (see vs_submissions_event_target in
-- events_v2.sql). Requires events_v2.sql applied first (vs_tiles + vs_events.owner_user_id).

-- Retire the old personal-board tables now that the view no longer references them (they're
-- superseded by vs_events(kind='personal') + vs_tiles). Personal boards are unreleased, so there's
-- no data to migrate. Safe/idempotent. If you re-run this file before events_v2.sql, comment these
-- out (the view above requires vs_tiles to exist first).
drop table if exists vs_personal_board_tiles;
drop table if exists vs_personal_boards;
