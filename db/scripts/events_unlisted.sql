-- Unlisted events + the permanent Dink Self-Test event. Apply by hand in the
-- Supabase SQL editor (no migration runner). Safe to re-run.
--
-- `unlisted` hides an event from the public /events list, the home-page stats,
-- and the bot's event announcements, while keeping it fully functional and
-- reachable by direct link. Built for utility events like the Dink self-test;
-- reusable for anything else that shouldn't advertise itself.
--
-- ⚠ Apply BEFORE deploying the site build that filters on this column (the
-- listing queries reference it), and before merging the bot's unlisted filter.

alter table vs_events add column if not exists unlisted boolean not null default false;

-- ── Dink Self-Test event ─────────────────────────────────────────────────────
-- Permanently-open, unlisted event whose tiles track trivial drops. /dink-check
-- auto-enrolls every visitor (a bare vs_event_signups row is all the active-tiles
-- view needs), so a member's flow is: open /dink-check → kill a chicken/cow →
-- watch the drop appear. required_qty is astronomically high ON PURPOSE: the
-- tiles must never complete, or the first credited drop would remove the tile
-- from vs_active_player_tiles and end that member's ability to re-test.

insert into vs_events (slug, name, kind, description, status, starts_at, unlisted)
select 'dink-self-test', 'Dink Self-Test', 'custom',
       'Connection check for Dink drop tracking — members are enrolled automatically from /dink-check. Not a competition.',
       'open', now(), true
where not exists (select 1 from vs_events where slug = 'dink-self-test');

-- Keep it open + unlisted across re-runs (e.g. if someone closed it by accident).
update vs_events set status = 'open', unlisted = true where slug = 'dink-self-test';

with ev as (select id from vs_events where slug = 'dink-self-test')
insert into vs_event_tiles (event_id, tile_id, row, tier, name, points)
select ev.id, t.tile_id, 1, 1, t.name, 0
from ev, (values
	('bones', 'Bones'),
	('cowhide', 'Cowhide'),
	('feather', 'Feather'),
	('raw-chicken', 'Raw chicken')
) as t(tile_id, name)
where not exists (
	select 1 from vs_event_tiles x where x.event_id = ev.id and x.tile_id = t.tile_id
);

with ev as (select id from vs_events where slug = 'dink-self-test')
insert into vs_event_tracked_items (event_id, tile_id, item_id, item_name, match_type, required_qty)
select ev.id, t.tile_id, t.item_id, t.item_name, 'loot', 1000000
from ev, (values
	('bones',       526,  'Bones'),
	('cowhide',     1739, 'Cowhide'),
	('feather',     314,  'Feather'),
	('raw-chicken', 2138, 'Raw chicken')
) as t(tile_id, item_id, item_name)
where not exists (
	select 1 from vs_event_tracked_items x
	where x.event_id = ev.id and x.tile_id = t.tile_id and x.item_id = t.item_id
);

-- PostgREST caches the schema; without this the new column 404s until restart.
notify pgrst, 'reload schema';
