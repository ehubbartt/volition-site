-- Gielinor Catan — MVP tester schema (see docs/GIELINOR-CATAN.md + docs/EVENTS.md).
-- Apply by hand in the Supabase SQL editor (no migration runner). Additive + idempotent;
-- safe to re-run. Requires events_v2.sql (vs_events with `structure` jsonb) to be applied.
--
-- Deliberately minimal: TWO tables. Only state that needs a database-level guarantee gets
-- a table — per-team wallet writes (row atomicity) and board occupancy (unique constraint).
-- Everything else rides on those rows / the event row as jsonb:
--   vs_events (kind='catan')  structure.catan = { board, deck, holders, freezes, log }
--   vs_catan_teams            hand (dev cards) + tasks (rolled tasks) jsonb per team
-- Task completions move into the vs_submissions ledger when the live event wires up real
-- players (per docs/EVENTS.md); the tester records them in the team's tasks jsonb.

-- Teams (8 × 4 for the first run; team roster wiring to vs_teams comes later).
create table if not exists vs_catan_teams (
	id         uuid primary key default gen_random_uuid(),
	event_id   uuid not null references vs_events (id) on delete cascade,
	position   int  not null,                     -- 1..8, stable display order
	name       text not null,
	color      text not null,                     -- hex color for board pieces
	tokens     jsonb not null default '{"boss":0,"skilling":0,"raids":0,"custom":0,"gold":0}'::jsonb,
	free_roads int  not null default 0,           -- pending Agility Shortcut roads
	hand       jsonb not null default '[]'::jsonb, -- dev cards: [{id, card, drawn_at, played_at, meta}]
	tasks      jsonb not null default '[]'::jsonb, -- rolled tasks: [{id, vertex, hex, task, status, payout, rolled_at, completed_at}]
	created_at timestamptz not null default now(),
	unique (event_id, position)
);
create index if not exists vs_catan_teams_event on vs_catan_teams (event_id);

-- Board pieces. loc is a geometry id: vertex ("q,r,N|S") for settlements/cities, edge
-- ("vid|vid") for roads. Vertex and edge ids never collide, so one uniqueness constraint
-- doubles as the occupancy rule for both corners and edges.
create table if not exists vs_catan_pieces (
	id         uuid primary key default gen_random_uuid(),
	event_id   uuid not null references vs_events (id) on delete cascade,
	team_id    uuid not null references vs_catan_teams (id) on delete cascade,
	kind       text not null check (kind in ('road', 'settlement', 'city')),
	loc        text not null,
	created_at timestamptz not null default now(),
	unique (event_id, loc)
);
create index if not exists vs_catan_pieces_event on vs_catan_pieces (event_id);

-- If you applied an earlier revision of this script (which also created dev-card/task/log
-- tables), fold them away — their data lives in the jsonb columns above now.
alter table vs_catan_teams add column if not exists hand  jsonb not null default '[]'::jsonb;
alter table vs_catan_teams add column if not exists tasks jsonb not null default '[]'::jsonb;
drop table if exists vs_catan_dev_cards;
drop table if exists vs_catan_tasks;
drop table if exists vs_catan_log;
