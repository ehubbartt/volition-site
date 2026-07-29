-- Battleship — schema (see docs/BATTLESHIP.md + docs/EVENTS.md).
-- Apply by hand (db/apply.sh or the Supabase SQL editor — no migration runner).
-- Additive + idempotent; safe to re-run. Requires events_v2.sql (vs_events.structure).
--
-- Deliberately table-light, same rule as gielinor_catan.sql: only state that needs a
-- DATABASE-level guarantee gets a table. Everything else rides on the event row's
-- structure jsonb (board config, phase, draft log) or on a team row's write atomicity.
--
--   vs_battleship_teams    — one row per side. `fleet` jsonb is written once, atomically,
--                            when that side locks its placement, so it needs no table.
--   vs_battleship_shots    — one row per CELL fired at. unique (event_id, target_side, cell)
--                            is the "a cell can only be fired at once" rule, and makes an
--                            overlapping bomb footprint a no-op instead of a double count.
--   vs_battleship_arsenal  — one row per earned bomb. unique (event_id, drop_key) is what
--                            makes Dink intake idempotent: reprocessing the same drop (the
--                            reconcile pass re-runs recent drops) can never mint a 2nd bomb.

-- ---------------------------------------------------------------------------
-- Sides. Exactly two rows per event today; the shape does not assume two, so a
-- free-for-all variant would not need a migration.
-- ---------------------------------------------------------------------------
create table if not exists vs_battleship_teams (
	id               uuid primary key default gen_random_uuid(),
	event_id         uuid not null references vs_events (id) on delete cascade,
	team_id          uuid references vs_teams (id) on delete set null,
	side             int  not null,                       -- 1 or 2; stable display order
	name             text not null,
	color            text not null,                       -- hex, for the board UI
	captain_user_id  uuid references vs_users (id) on delete set null,
	-- [{ id, len, name, cells: ["x,y", ...] }] — the side's placed fleet. Written once
	-- when placement locks; read on every shot to resolve hits.
	fleet            jsonb not null default '[]'::jsonb,
	placed_at        timestamptz,
	created_at       timestamptz not null default now(),
	unique (event_id, side)
);
create index if not exists vs_battleship_teams_event on vs_battleship_teams (event_id);

-- ---------------------------------------------------------------------------
-- Shots. One row per cell, NOT per bomb: a 3x3 bomb writes up to 9 rows sharing a
-- `bomb_id`. Inserting with ON CONFLICT DO NOTHING against the unique index means
-- overlapping bombs silently skip already-hit cells, so re-firing over a previous
-- crater cannot double-count a hit or sink a ship twice.
--
-- `cell` is "x,y" (0-indexed, x = column, y = row) to keep the unique index one column.
-- `target_side` is the side being SHOT AT (so a row is "side N's water was hit here").
-- ---------------------------------------------------------------------------
create table if not exists vs_battleship_shots (
	id            uuid primary key default gen_random_uuid(),
	event_id      uuid not null references vs_events (id) on delete cascade,
	target_side   int  not null,                          -- whose board this cell belongs to
	cell          text not null,                          -- "x,y"
	bomb_id       uuid not null,                          -- groups the cells of one bomb
	tier          int  not null,                          -- 1..3, the bomb that made this crater
	by_user_id    uuid references vs_users (id) on delete set null,
	hit           boolean not null default false,
	ship_id       text,                                   -- which ship was hit, if any
	fired_at      timestamptz not null default now(),
	unique (event_id, target_side, cell)
);
create index if not exists vs_battleship_shots_event on vs_battleship_shots (event_id, target_side);
create index if not exists vs_battleship_shots_bomb on vs_battleship_shots (bomb_id);

-- ---------------------------------------------------------------------------
-- Arsenal — bombs earned from drops but not yet fired.
--
-- drop_key mirrors vs_dink_drops.drop_key (the proxy's dedup key) so intake is
-- idempotent at the database level rather than by hoping the consumer runs once.
-- Manually granted bombs (admin, testing) use a synthetic key so they share the guard.
-- ---------------------------------------------------------------------------
create table if not exists vs_battleship_arsenal (
	id              uuid primary key default gen_random_uuid(),
	event_id        uuid not null references vs_events (id) on delete cascade,
	side            int  not null,                        -- the side that earned it
	earned_by       uuid references vs_users (id) on delete set null,
	tier            int  not null,                        -- 1..3
	value           bigint not null default 0,            -- the drop's gp value, for display
	item_name       text,
	source          text,                                 -- the NPC/container, for display
	drop_key        text not null,
	earned_at       timestamptz not null default now(),
	spent_at        timestamptz,
	bomb_id         uuid,                                 -- set when fired; joins to the shots
	unique (event_id, drop_key)
);
create index if not exists vs_battleship_arsenal_event on vs_battleship_arsenal (event_id, side);
-- The "unspent bombs for this side" read, which every board load runs.
create index if not exists vs_battleship_arsenal_unspent
	on vs_battleship_arsenal (event_id, side) where spent_at is null;

-- ---------------------------------------------------------------------------
-- Value-tracked participants — the ONE thing the dink-proxy needs to know about
-- Battleship. Unlike bingo, no item allowlist can express "any drop over 5m": the
-- proxy has to record on VALUE. This view names the members whose drops should be
-- recorded regardless of item, and the floor to apply.
--
-- Only sides that are actually in the battle phase are emitted, so the proxy stops
-- recording the moment an event ends — no prune job, same declarative style as the
-- self-test pin's expiry.
-- ---------------------------------------------------------------------------
create or replace view vs_value_tracked_rsns
with (security_invoker = true) as
select
	lower(u.rsn) as rsn,
	min(
		coalesce(
			(e.structure #>> '{battleship,tiers,0,min_value}')::bigint,
			5000000
		)
	) as min_value
from vs_events e
join vs_battleship_teams bt on bt.event_id = e.id
join vs_event_signups s on s.event_id = e.id and s.team_id = bt.team_id
join vs_users u on u.id = s.user_id
where e.kind = 'battleship'
  and e.status = 'open'
  and coalesce(e.structure #>> '{battleship,phase}', '') = 'battle'
  and u.rsn is not null
  and u.rsn <> ''
group by lower(u.rsn);

comment on view vs_value_tracked_rsns is
	'dink-proxy reads this: members whose drops must be recorded on VALUE (any item) '
	'because they are in a live Battleship battle, plus the gp floor to apply.';
