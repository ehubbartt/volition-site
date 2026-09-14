-- Connect Four — INTERNAL TEAMS (squads). Hand-applied and idempotent (this repo has no
-- migration runner): db/apply.sh --staging db/scripts/connect4_squads.sql
--
-- WHY A SEPARATE WORD. `vs_teams` / `vs_event_signups.team_id` already means "which of the
-- two SIDES you play for" — Volition or IronClad. This table is a second, finer grouping
-- that lives INSIDE one side: the clan splits its own players into Red/Blue/Yellow and
-- wants an internal leaderboard without changing the clan-vs-clan game at all. Calling
-- both of those "team" in the schema would guarantee somebody joins the wrong one, so the
-- inner grouping is a SQUAD everywhere in the code and only reads as "team" in the UI.
--
-- Nothing here feeds the board's scoring. A squad never owns a cell, never claims a tile
-- and never changes a side's total; squad standings are a re-attribution of points the
-- side has already scored, derived on read like everything else in this game.
--
-- Visibility is enforced in the application (src/lib/server/connect4Page.ts): the squad
-- payload is only built for a viewer seated on the squads' own side, or for an admin. The
-- opposing clan never receives it.

create table if not exists vs_connect4_squads (
	event_id   uuid not null references vs_events (id) on delete cascade,
	user_id    uuid not null references vs_users (id) on delete cascade,
	-- Free text, lowercased by convention ('red', 'blue', 'yellow'). The display name and
	-- colour come from SQUAD_PALETTE in src/lib/connect4/squads.ts, which falls back to a
	-- generated label + palette colour for a key it has never seen — so adding a fourth
	-- squad needs no code change, only rows.
	squad      text not null check (length(btrim(squad)) > 0),
	created_at timestamptz not null default now(),
	-- One squad per player per event. Re-running an assignment is an upsert, not a second
	-- membership, which is what keeps the proportional split summing to 1.
	primary key (event_id, user_id)
);

create index if not exists vs_connect4_squads_event on vs_connect4_squads (event_id, squad);
