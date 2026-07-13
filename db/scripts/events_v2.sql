-- Events v2 — the standard data spine for NEW events/boards (see docs/EVENTS.md).
-- Apply by hand in the Supabase SQL editor (no migration runner). Additive + idempotent; safe to
-- re-run. Nothing here touches existing events — it's opt-in, consumed by the first v2 event.
--
-- Spine: vs_events (+ owner_user_id) · vs_tiles · vs_event_participants · vs_submissions (+ source)
--        · vs_active_tiles (view). Completions all live in the vs_submissions LEDGER; progress is
--        derived from it. Auto-track rules live in vs_tiles.triggers (jsonb), read only through the
--        vs_active_tiles view.

-- 1) vs_events: personal boards reuse this table (owner_user_id set, kind='personal'). Shared
--    events set owner_user_id to the creating admin (so "who to contact" can be shown); only
--    personal boards are hidden from event lists (filter `kind <> 'personal'`).
alter table vs_events add column if not exists owner_user_id uuid references vs_users (id) on delete cascade;
create index if not exists vs_events_owner on vs_events (owner_user_id);
-- locked_at: personal boards' commitment/activation timestamp (was on the old vs_personal_boards).
-- Null = draft/never-locked; the active-tiles view uses it as the personal activation time.
alter table vs_events add column if not exists locked_at timestamptz;
-- One personal board per user (partial unique — shared events are unconstrained).
create unique index if not exists vs_events_personal_owner on vs_events (owner_user_id) where kind = 'personal';

-- 2) vs_submissions: mark HOW a credit was made so auto vs manual is distinguishable and auto rows
--    can be deduped. ('manual' | 'dink' | 'clog' | 'wom' | 'wikisync' | …). Nullable = legacy/manual.
alter table vs_submissions add column if not exists source text;

-- 3) vs_tiles: generic board objective. Structural fields are columns; kind-specific DISPLAY extras
--    go in meta (jsonb) and auto-complete rules go in triggers (jsonb) — so no per-kind columns and
--    no separate triggers table.
create table if not exists vs_tiles (
	id             uuid primary key default gen_random_uuid(),
	event_id       uuid not null references vs_events (id) on delete cascade,
	tile_key       text not null,                 -- stable id within the event (submission target_id)
	kind           text not null default 'item',  -- 'item' | 'skill' | 'ca' | 'manual' | …
	name           text,
	description_md text,
	img            text,
	points         int  not null default 0,
	section        text,                           -- group / floor / row bucket (topology)
	position       int,                            -- ordering within the board
	meta           jsonb not null default '{}'::jsonb,   -- display-only, kind-specific (target_xp, ca_tier, ehb…)
	triggers       jsonb not null default '[]'::jsonb,   -- [{type, match_key, required_qty, source_name}] · [] = manual
	created_at     timestamptz not null default now(),
	unique (event_id, tile_key)
);
create index if not exists vs_tiles_event on vs_tiles (event_id);

-- 4) vs_event_participants: who is "on" an event (generalizes signups). Personal boards = owner only.
create table if not exists vs_event_participants (
	id           uuid primary key default gen_random_uuid(),
	event_id     uuid not null references vs_events (id) on delete cascade,
	user_id      uuid not null references vs_users (id) on delete cascade,
	team_id      uuid references vs_teams (id) on delete set null,   -- null = solo/personal
	activated_at timestamptz not null default now(),                 -- when this player's tiles go live
	unique (event_id, user_id)
);
create index if not exists vs_event_participants_event on vs_event_participants (event_id);

-- 5) Active-tiles index: rather than a second view, the existing `vs_active_player_tiles`
--    (db/scripts/active_tiles.sql) is EVOLVED in place — its personal branch now reads
--    vs_events(kind='personal') + vs_tiles + vs_submissions (see that file). The Dink consumer and
--    proxy allowlist keep reading the same view/columns. APPLY ORDER: run THIS file first (so
--    vs_tiles + the `source` column exist), then re-apply active_tiles.sql.

-- Helpful index for the ledger-derived "is this tile complete for this owner" check.
create index if not exists vs_submissions_event_target on vs_submissions (event_id, target_id, status);

-- 6) The old personal-board tables (vs_personal_boards / vs_personal_board_tiles) are dropped at
--    the END of active_tiles.sql — i.e. only AFTER the view is recreated to no longer reference
--    them. APPLY ORDER: this file → active_tiles.sql (which recreates the view and then drops them).
