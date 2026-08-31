-- Connect Four — schema. Hand-applied and idempotent (this repo has no migration
-- runner): db/apply.sh --staging db/scripts/connect4.sql
--
-- See docs/CONNECT4.md. Only ONE table, because only one piece of this game needs a
-- guarantee the database can make and the application cannot:
--
--   unique (event_id, col, row)  IS the "first team to the tile claims it" rule. Both
--     sides racing the same shared tile compute the same landing cell, both insert, and
--     exactly one lands — arbitration by constraint, never by read-then-write.
--   unique (event_id, drop_key)  IS the idempotency guard. The Dink reconcile pass
--     deliberately re-runs drops up to three days old, so a claim must be safe to attempt
--     any number of times.
--
-- Everything else about a game — phase, scoring config, the shuffled deck, the sides —
-- lives in vs_events.structure->'connect4', and the board, the standings and the winner
-- are derived from these rows on every read. There is nothing here to keep in sync.
--
-- Teams reuse vs_teams + vs_event_signups.team_id like every other event; the 25 live
-- objectives are projected into vs_event_tracked_items (see syncTrackedItems), which is
-- what puts them in the Dink proxy's allowlist with no proxy change.

create table if not exists vs_connect4_pieces (
	id          uuid primary key default gen_random_uuid(),
	event_id    uuid not null references vs_events (id) on delete cascade,
	-- 0-indexed, row 0 at the BOTTOM of the board (pieces fall onto row 0).
	col         int  not null,
	row         int  not null,
	side        int  not null check (side in (1, 2)),
	-- Which curated tile this claim completed: col * ROWS + row into the dealt deck.
	deck_idx    int  not null,
	item_id     int,
	item_name   text,
	source      text,
	by_user_id  uuid references vs_users (id) on delete set null,
	-- vs_dink_drops.drop_key, or 'manual:<uuid>' / 'admin:<uuid>' / 'test-…'.
	drop_key    text not null,
	claimed_at  timestamptz not null default now(),
	unique (event_id, col, row),
	unique (event_id, drop_key)
);

create index if not exists vs_connect4_pieces_event on vs_connect4_pieces (event_id);
create index if not exists vs_connect4_pieces_order on vs_connect4_pieces (event_id, claimed_at);

-- Boards are sized per game (structure.connect4.size) since sizes became configurable,
-- so the exact 25×10 bounds and the deck_idx arithmetic moved into the application —
-- the database can't know a given event's rows. What remains is what is true for every
-- size. Re-running this file upgrades an older install's stricter constraint in place.
alter table vs_connect4_pieces drop constraint if exists vs_connect4_pieces_bounds;
alter table vs_connect4_pieces add constraint vs_connect4_pieces_bounds
	check (col >= 0 and row >= 0 and deck_idx >= 0);
