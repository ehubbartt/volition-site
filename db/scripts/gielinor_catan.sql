-- Gielinor Catan — MVP tester schema (see docs/GIELINOR-CATAN.md + docs/EVENTS.md).
-- Apply by hand in the Supabase SQL editor (no migration runner). Additive + idempotent;
-- safe to re-run. Requires events_v2.sql (vs_events with `structure` jsonb) to be applied.
--
-- The game container is a vs_events row (kind='catan'); the generated board, remaining
-- dev-card deck, stealable-bonus holders and active PKer freezes live in its `structure`
-- jsonb. Per-team mutable state lives in the tables below. In the MVP tester an admin
-- acts as every team; task completions are recorded in vs_catan_tasks (wiring them into
-- the vs_submissions ledger comes with the live event, when real players submit proof).

-- Teams (8 × 4 for the first run; team roster wiring to vs_teams comes later).
create table if not exists vs_catan_teams (
	id         uuid primary key default gen_random_uuid(),
	event_id   uuid not null references vs_events (id) on delete cascade,
	position   int  not null,                     -- 1..8, stable display order
	name       text not null,
	color      text not null,                     -- hex color for board pieces
	tokens     jsonb not null default '{"boss":0,"skilling":0,"raids":0,"custom":0,"gold":0}'::jsonb,
	free_roads int  not null default 0,           -- pending Agility Shortcut roads
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

-- Development cards a team has drawn. played_at null = still in hand. meta holds
-- play details (PKer target corner, Bond token type, …).
create table if not exists vs_catan_dev_cards (
	id        uuid primary key default gen_random_uuid(),
	event_id  uuid not null references vs_events (id) on delete cascade,
	team_id   uuid not null references vs_catan_teams (id) on delete cascade,
	card      text not null check (card in ('pker', 'vp', 'bond', 'birdhouse', 'shortcut')),
	drawn_at  timestamptz not null default now(),
	played_at timestamptz,
	meta      jsonb not null default '{}'::jsonb
);
create index if not exists vs_catan_dev_cards_event on vs_catan_dev_cards (event_id);

-- Rolled tasks (§3: roll a corner → random touching tile → random task on it).
-- task jsonb snapshot: { label, unit, amount, type, rating }. payout jsonb records the
-- tokens credited at completion time (same-type multiplier applied then, not at roll).
create table if not exists vs_catan_tasks (
	id           uuid primary key default gen_random_uuid(),
	event_id     uuid not null references vs_events (id) on delete cascade,
	team_id      uuid not null references vs_catan_teams (id) on delete cascade,
	vertex       text not null,
	hex          text not null,
	task         jsonb not null,
	status       text not null default 'active' check (status in ('active', 'completed', 'abandoned')),
	payout       jsonb,
	rolled_at    timestamptz not null default now(),
	completed_at timestamptz
);
create index if not exists vs_catan_tasks_event on vs_catan_tasks (event_id);

-- Append-only action log — the async event's paper trail, and the tester's debug view.
create table if not exists vs_catan_log (
	id         uuid primary key default gen_random_uuid(),
	event_id   uuid not null references vs_events (id) on delete cascade,
	team_id    uuid references vs_catan_teams (id) on delete set null,
	action     text not null,
	detail     jsonb not null default '{}'::jsonb,
	created_at timestamptz not null default now()
);
create index if not exists vs_catan_log_event on vs_catan_log (event_id, created_at);
