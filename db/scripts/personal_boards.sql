-- Personal PVM collection-log bingo boards. Apply by hand in the Supabase SQL editor
-- (no migration runner). Safe to re-run.
--
-- A user has at most ONE board (unique user_id); regenerating replaces it. Tiles are
-- collection-log items the user doesn't own yet, costed by EHB. `obtained` is flipped
-- by re-polling the player's collection log (see src/lib/server/personalBoard.ts).
-- The owner (user_id) lives on the board so a future Dink auto-tracker can credit the
-- owning user directly without the event model's credit-by-dropper ambiguity.

create table if not exists vs_personal_boards (
	id          uuid primary key default gen_random_uuid(),
	user_id     uuid not null references vs_users (id) on delete cascade,
	rsn         text not null,            -- snapshot of the RSN the clog was read from
	size        int  not null,            -- 3..5 (grid is size × size)
	difficulty  int  not null,            -- 1..10 difficulty dial
	created_at  timestamptz not null default now(),
	unique (user_id)                      -- one active board per user
);

create table if not exists vs_personal_board_tiles (
	id          uuid primary key default gen_random_uuid(),
	board_id    uuid not null references vs_personal_boards (id) on delete cascade,
	idx         int  not null,            -- 0 .. size*size-1, row-major
	item_id     int  not null,            -- OSRS item id (from itemEhb.json)
	item_name   text not null,
	ehb         real not null,            -- cheapest EHB-to-obtain (difficulty of the tile)
	source      text,                     -- boss/raid the EHB is costed from
	obtained    boolean not null default false,
	obtained_at timestamptz,
	unique (board_id, idx)
);

create index if not exists vs_personal_board_tiles_board on vs_personal_board_tiles (board_id);
