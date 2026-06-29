-- Manual EHB overrides. Apply by hand in the Supabase SQL editor (no migration runner).
-- Safe to re-run.
--
-- EHB is a computed estimate; this table lets admins correct it without hand-editing the
-- auto-generated src/lib/server/data/itemEhb.json (which build_item_ehb.mjs would wipe).
-- Two kinds:
--   * 'boss' — key (mechanic, source_name) → `rate` (kills/raids per hour). Replaces the
--     boss's EhbSource.r, so EVERY drop from that boss re-costs. (Doom uses doomKph, not r;
--     boss overrides don't apply to it.)
--   * 'item' — key item_id → `ehb_hours`, a direct final EHB that wins outright for that item.
-- The EHB math layers these on top of itemEhb.json in memory (see src/lib/server/ehbOverrides.ts),
-- so they survive regeneration as long as the source name / item id is stable.

create table if not exists vs_ehb_overrides (
	id          uuid primary key default gen_random_uuid(),
	kind        text not null check (kind in ('boss', 'item')),
	-- boss kind:
	mechanic    text,        -- EhbSource.t ('kill'|'cox'|'tobn'|'tobh'|'toa')
	source_name text,        -- EhbSource.s (boss / chest display name)
	rate        real,        -- override kills/raids per hour (replaces EhbSource.r)
	-- item kind:
	item_id     int,         -- ItemEhb.id
	ehb_hours   real,        -- direct final EHB in hours
	note        text,
	updated_by  text,        -- discord_id of the admin who set it
	updated_at  timestamptz not null default now(),
	-- One override per target. These are the upsert conflict targets. They're plain (not
	-- partial) so PostgREST upsert can use them; the "other kind" leaves these columns null,
	-- and Postgres treats nulls as distinct, so item rows don't collide on (mechanic,
	-- source_name) and boss rows don't collide on (item_id).
	unique (mechanic, source_name),
	unique (item_id)
);
