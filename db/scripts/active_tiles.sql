-- Unified per-player ACTIVE-TILES index. Apply by hand in the Supabase SQL editor
-- (no migration runner). Safe to re-run.
--
-- `vs_active_player_tiles` is a LIVE VIEW: one row per (player, tile) the player can
-- currently complete, across all OPEN events plus their personal collection-log board.
-- Each row carries a `type` discriminator — 'item' tiles are auto-trackable by Dink
-- (carry item_id + match_type); 'manual' tiles are proof-submission only but are still
-- represented so this is the single source of truth for "what is this player on".
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
join vs_event_signups s on s.event_id = te.event_id
join vs_users         u on u.id = s.user_id
where not exists (select 1 from vs_event_tracked_items ti
                  where ti.event_id = te.event_id and ti.tile_id = te.tile_id)
  and not exists (select 1 from vs_bingo_completions c
                  where c.event_id = te.event_id and c.user_id = s.user_id
                    and c.tile_id = te.tile_id and c.status = 'approved')
union all
-- (3) Personal collection-log board tiles (always item; a clog unlock fires a Dink
--     COLLECTION notif). Only LOCKED boards are tracked — a draft isn't in play. The
--     activation time is the LOCK time, so a drop obtained before locking never credits.
select b.user_id, b.rsn,
       'personal'::text, 'item'::text,
       null::uuid, null::text,
       b.id, t.idx,
       t.item_name,
       t.item_id, t.item_name, 'collection'::text, 1,
       b.locked_at
from vs_personal_board_tiles t
join vs_personal_boards b on b.id = t.board_id
where t.obtained = false and b.locked_at is not null
  and t.kind = 'item' and t.item_id is not null; -- skill tiles are WoM-tracked, not Dink drops

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

-- Supporting indexes (the view is filtered by user_id in the consumer).
create index if not exists vs_event_signups_user      on vs_event_signups (user_id);
create index if not exists vs_event_signups_event     on vs_event_signups (event_id);
create index if not exists vs_event_tracked_items_evt on vs_event_tracked_items (event_id, tile_id);
create index if not exists vs_event_tiles_evt         on vs_event_tiles (event_id, tile_id);
create index if not exists vs_bingo_completions_ut    on vs_bingo_completions (user_id, event_id, tile_id);
-- vs_personal_board_tiles(board_id) already indexed in personal_boards.sql.
