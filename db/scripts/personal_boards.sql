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
	locked_at   timestamptz,              -- null = DRAFT (reroll freely, not tracked); set = locked & tracked
	unique (user_id)                      -- one active board per user
);

-- For databases created before the lock lifecycle. A board is a DRAFT until locked_at is
-- set: drafts can be rerolled freely and are NOT tracked; locking starts progress tracking
-- and a 1-month commitment before the board can be reset and regenerated.
alter table vs_personal_boards add column if not exists locked_at timestamptz;

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

-- Skilling tiles ("gain N XP in skill X"), mixed into the same board. A tile is `kind='item'`
-- (a collection-log drop, tracked via clog/Dink) or `kind='skill'` (XP goal, tracked via WoM
-- "gained since locked_at"). The existing `ehb` column doubles as the tile's cost in efficient
-- hours (EHB for items, EHP for skills) so the difficulty gradient works for both. Item-only
-- columns become nullable for skill rows. Additive + idempotent.
alter table vs_personal_board_tiles add column if not exists kind text not null default 'item';
alter table vs_personal_board_tiles add column if not exists skill text;        -- skill name (kind='skill')
alter table vs_personal_board_tiles add column if not exists target_xp bigint;  -- XP goal
alter table vs_personal_board_tiles add column if not exists baseline_xp bigint;-- skill XP snapshot at lock
alter table vs_personal_board_tiles add column if not exists progress_xp bigint;-- last gained-since-lock (display)
alter table vs_personal_board_tiles alter column item_id drop not null;
alter table vs_personal_board_tiles alter column item_name drop not null;

-- Combat Achievement tiles ("complete CA <name>"), also mixed into the same board. A tile is
-- additionally `kind='ca'`: the CA's display name lives in item_name (reused), the WikiSync
-- task id in ca_id, and its tier in ca_tier. Tracked by re-polling WikiSync's completed-CA set
-- (no XP baseline — a CA is excluded if already done at generation and credited when its id
-- enters the completed set, the same model as clog items). Additive + idempotent.
alter table vs_personal_board_tiles add column if not exists ca_id int;    -- WikiSync CA task id (kind='ca')
alter table vs_personal_board_tiles add column if not exists ca_tier text; -- 'easy'..'grandmaster'

-- Manual submissions: a member can mark a tile done by hand (with optional proof screenshots),
-- for drops/goals the auto-trackers miss. Self-serve (personal boards have no review flow), so
-- `manual` flags the tile as owner-attested and `proof_urls` holds any uploaded proof (shared
-- bingo bucket). Additive + idempotent.
alter table vs_personal_board_tiles add column if not exists manual boolean not null default false;
alter table vs_personal_board_tiles add column if not exists proof_urls text[];
