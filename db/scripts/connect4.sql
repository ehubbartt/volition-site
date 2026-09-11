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

-- ---------------------------------------------------------------------------
-- Per-side progress toward QUANTITY tiles (tile.qty > 1): one row per qualifying
-- drop, "first side to its Nth drop claims the tile". Same guard as the pieces:
-- unique (event_id, drop_key) is what makes the reconcile pass's re-runs count a
-- drop once, ever, no matter how many times it drains. Rows are keyed to the DECK
-- SLOT (deck_idx), not the item, so the same item in two slots races separately.
-- The Nth drop inserts its progress row and then claims the piece with the SAME
-- drop_key; both tables' guards hold independently. Progress for a slot the other
-- side claimed is left in place and simply never consulted again.
-- ---------------------------------------------------------------------------
create table if not exists vs_connect4_progress (
	id          uuid primary key default gen_random_uuid(),
	event_id    uuid not null references vs_events (id) on delete cascade,
	deck_idx    int  not null check (deck_idx >= 0),
	side        int  not null check (side in (1, 2)),
	by_user_id  uuid references vs_users (id) on delete set null,
	item_name   text,
	drop_key    text not null,
	created_at  timestamptz not null default now(),
	unique (event_id, drop_key)
);
create index if not exists vs_connect4_progress_slot
	on vs_connect4_progress (event_id, deck_idx, side);

-- ---------------------------------------------------------------------------
-- BONUS awards: points that sit beside the board rather than on it. A pet is the
-- motivating case — pets are filtered out of the tile generator on purpose, but a
-- clan getting one during the event should still be worth something — so an admin
-- records it by hand and the side's total goes up without a piece being placed.
--
-- The awarded `points` are STORED per row, not recomputed from the scoring config
-- like tile and line points are. An award is a ledger entry: retuning the default
-- later must not silently restate what a side was already told it had banked.
--
-- `drop_key` is nullable and unique per event, which in Postgres lets any number of
-- hand-entered rows coexist (NULLs never conflict) while leaving the same
-- idempotency guard the pieces table uses available if pet awards are ever
-- automated from Dink.
-- ---------------------------------------------------------------------------
create table if not exists vs_connect4_bonus (
	id          uuid primary key default gen_random_uuid(),
	event_id    uuid not null references vs_events (id) on delete cascade,
	side        int  not null check (side in (1, 2)),
	points      int  not null,
	kind        text not null default 'pet',
	item_name   text,
	by_user_id  uuid references vs_users (id) on delete set null,
	note        text,
	awarded_by  uuid references vs_users (id) on delete set null,
	drop_key    text,
	created_at  timestamptz not null default now(),
	unique (event_id, drop_key)
);
create index if not exists vs_connect4_bonus_event
	on vs_connect4_bonus (event_id, created_at desc);

-- ---------------------------------------------------------------------------
-- PROVISIONAL pieces.
--
-- A claim is submitted with proof and reviewed, which raises a fairness question the
-- old model got wrong: if the piece only lands on APPROVAL, then whoever an admin
-- happens to review first wins a contested tile, not whoever got the drop first. So a
-- submission places the piece immediately as `pending`, and review either confirms it
-- or takes it away. Submission order settles the race; review lag cannot change it.
--
-- `submission_id` ties the piece back to the vs_submissions row that placed it, so a
-- decision on that row can find its piece without guessing.
--
-- Pieces made by an admin's direct credit are 'confirmed' on the spot — there is
-- nothing to review — which is why the default is 'confirmed' and existing rows need
-- no backfill.
-- ---------------------------------------------------------------------------
alter table vs_connect4_pieces
	add column if not exists status text not null default 'confirmed';
alter table vs_connect4_pieces
	add column if not exists submission_id uuid;

alter table vs_connect4_pieces drop constraint if exists vs_connect4_pieces_status_check;
alter table vs_connect4_pieces add constraint vs_connect4_pieces_status_check
	check (status in ('pending', 'confirmed'));

create index if not exists vs_connect4_pieces_submission
	on vs_connect4_pieces (submission_id) where submission_id is not null;

-- ---------------------------------------------------------------------------
-- Progress rows carry an AMOUNT.
--
-- A ×N tile used to mean N separate drops, so one row per drop and count(*) was
-- the whole story. This board also counts amounts — 70,000 Mixology points,
-- 6,000 Stardust, 1,500 Colossal Wyrm laps — and 22 of its tiles ask for more
-- than 99. One row per unit is absurd at that scale, so a claim banks ONE row
-- carrying how much it covered, and progress is sum(qty) rather than count(*).
-- Existing rows are worth 1, which is exactly what they meant.
alter table vs_connect4_progress add column if not exists qty int not null default 1;
alter table vs_connect4_progress drop constraint if exists vs_connect4_progress_qty_positive;
alter table vs_connect4_progress add constraint vs_connect4_progress_qty_positive check (qty > 0);
