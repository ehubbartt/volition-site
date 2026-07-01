-- Events v2 — the standard data spine for NEW events/boards (see docs/EVENTS.md).
-- Apply by hand in the Supabase SQL editor (no migration runner). Additive + idempotent; safe to
-- re-run. Nothing here touches existing events — it's opt-in, consumed by the first v2 event.
--
-- Spine: vs_events (+ owner_user_id) · vs_tiles · vs_event_participants · vs_submissions (+ source)
--        · vs_active_tiles (view). Completions all live in the vs_submissions LEDGER; progress is
--        derived from it. Auto-track rules live in vs_tiles.triggers (jsonb), read only through the
--        vs_active_tiles view.

-- 1) vs_events: personal boards reuse this table (owner_user_id set, kind='personal'). Shared
--    events leave it null. Public/admin event lists must filter `owner_user_id is null`.
alter table vs_events add column if not exists owner_user_id uuid references vs_users (id) on delete cascade;
create index if not exists vs_events_owner on vs_events (owner_user_id);

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

-- 5) vs_active_tiles (VIEW) — the single index every auto-tracker reads: one row per
--    (participant × not-yet-complete tile × trigger). Build/finalize this WITH the first v2 event
--    so its completion check and event-live/lock predicates match the real vs_events columns. The
--    view is PERMISSIVE (a not-complete tile is creditable); unlock/gating is display/scoring only,
--    handled in the per-kind TS strategy — never split gating across SQL and TS.
--
-- Intended shape (finalize columns against live vs_events / vs_submissions before applying):
--
--   create or replace view vs_active_tiles as
--   select p.user_id, u.rsn, p.team_id, e.id as event_id, e.kind,
--          t.tile_key, t.kind as tile_kind,
--          trig->>'type'                         as type,
--          trig->>'match_key'                    as match_key,
--          coalesce((trig->>'required_qty')::int, 1) as required_qty,
--          trig->>'source_name'                  as source_name,
--          p.activated_at
--   from vs_event_participants p
--   join vs_events e on e.id = p.event_id
--   join vs_users  u on u.id = p.user_id
--   join vs_tiles  t on t.event_id = e.id
--   cross join lateral jsonb_array_elements(t.triggers) as trig
--   where (e.owner_user_id is null and e.status = 'open')          -- shared events: open
--      or (e.owner_user_id is not null and e.locked_at is not null) -- personal boards: locked
--     and not exists (                                              -- tile not already completed
--       select 1 from vs_submissions s
--       where s.event_id = e.id and s.target_id = t.tile_key and s.status = 'approved'
--         and coalesce(s.team_id, s.user_id) = coalesce(p.team_id, p.user_id)
--       group by s.event_id, s.target_id
--       having sum(coalesce(s.quantity, 1)) >= (
--         select coalesce(max((tr->>'required_qty')::int), 1)
--         from jsonb_array_elements(t.triggers) tr)
--     );
--
-- Manual tiles (triggers = []) won't appear (no trigger rows); include a `type='manual'` union if
-- the index should also list proof-only tiles for completeness (as the current
-- vs_active_player_tiles does).
