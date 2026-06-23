-- ============================================================================
-- Event Builder + Dink auto-tracking schema
-- ============================================================================
-- Adds the data-driven event-structure tables (so admins can build/clone bingo
-- events without code changes) and the Dink auto-tracking pipeline tables (the
-- ingestion sink + the manifest the dink-proxy Worker reads).
--
-- Apply by hand in the Supabase SQL editor (this project applies migrations
-- manually; see vs_duo_tiles / vs_accept_invite for prior art). Safe to re-run.
-- ============================================================================

-- Per-event structural config (bingo timing, tier point values, bonus column).
-- NULL → the board falls back to the hardcoded code defaults (legacy echo-rumors).
alter table vs_events add column if not exists structure jsonb;

-- ----------------------------------------------------------------------------
-- vs_event_templates — reusable, clonable event blueprints.
-- Built-in templates (echo-rumors) build their tile content from code at clone
-- time; this table also lets admins save their own templates later.
-- ----------------------------------------------------------------------------
create table if not exists vs_event_templates (
    id            uuid primary key default gen_random_uuid(),
    slug          text unique not null,
    name          text not null,
    kind          text not null,                       -- 'bingo' | 'duo' | ...
    structure     jsonb not null,                      -- BingoStructure config
    tiles         jsonb not null default '[]'::jsonb,  -- [{tile_id,row,tier,name,points,details_md,img}]
    tracked_items jsonb not null default '[]'::jsonb,  -- optional default tracked items
    created_at    timestamptz not null default now()
);

-- Metadata row for the built-in Echo Rumors bingo template. Tile content for this
-- built-in is generated from code (BINGO_TILES) at clone time, so `tiles` stays [].
insert into vs_event_templates (slug, name, kind, structure)
values (
    'echo-rumors',
    'Echo Rumors (bingo)',
    'bingo',
    '{"rowCount":12,"rowIntervalHours":14,"bonusEnabled":true,"tiers":[{"key":"skilling","label":"Skilling Tier","points":1},{"key":"easy","label":"Easy Tier","points":2},{"key":"medium","label":"Medium Tier","points":3},{"key":"hard","label":"Hard Tier","points":4},{"key":"bonus","label":"Bonus","points":5}]}'::jsonb
)
on conflict (slug) do nothing;

-- ----------------------------------------------------------------------------
-- vs_event_tiles — per-event tile content (data-driven replacement for the
-- hardcoded ROWS / BONUS / TILE_DETAILS). One row per tile of a built event.
-- ----------------------------------------------------------------------------
create table if not exists vs_event_tiles (
    id          uuid primary key default gen_random_uuid(),
    event_id    uuid not null references vs_events(id) on delete cascade,
    tile_id     text not null,            -- 'r5-hard' | 'b3'
    row         int  not null,
    tier        text not null,            -- skilling|easy|medium|hard|bonus
    name        text not null,
    points      int  not null default 0,
    details_md  text,
    img         text,
    created_at  timestamptz not null default now(),
    unique (event_id, tile_id)
);
create index if not exists vs_event_tiles_event on vs_event_tiles (event_id);

-- ----------------------------------------------------------------------------
-- vs_event_tracked_items — which OSRS items auto-credit which tile, per event.
-- ----------------------------------------------------------------------------
create table if not exists vs_event_tracked_items (
    id            uuid primary key default gen_random_uuid(),
    event_id      uuid not null references vs_events(id) on delete cascade,
    tile_id       text not null,
    item_id       int,
    item_name     text not null,
    required_qty  int not null default 1,
    source_name   text,                   -- optional: require extra.source to match
    created_at    timestamptz not null default now()
);
create index if not exists vs_event_tracked_items_event on vs_event_tracked_items (event_id);

-- How a drop satisfies this tile:
--   'loot'       — a LOOT notification for the item (default; today's behaviour)
--   'collection' — a COLLECTION-log unlock for the item (also covers pets, which are
--                  clog slots). Collection notifications aren't value-gated, so these
--                  don't need the loot allowlist.
alter table vs_event_tracked_items add column if not exists match_type text not null default 'loot';

-- ----------------------------------------------------------------------------
-- vs_dink_drops — raw, append-only ingestion sink written by the proxy.
-- drop_key gives idempotency against Dink's retries; processed flips once the
-- site consumer (processDinkDrops) has credited the matching tile.
-- ----------------------------------------------------------------------------
create table if not exists vs_dink_drops (
    id           bigserial primary key,
    event_id     uuid references vs_events(id) on delete set null,
    rsn          text not null,
    item_id      int,
    item_name    text,
    quantity     int not null default 1,
    source       text,
    dink_ts      timestamptz,             -- client (informational)
    received_at  timestamptz not null default now(),  -- authoritative "during event"
    drop_key     text unique not null,    -- hash(rsn|item_id|source|dink_ts|quantity)
    processed    boolean not null default false
);
create index if not exists vs_dink_drops_unprocessed on vs_dink_drops (processed) where processed = false;

-- What kind of Dink notification produced this row ('loot' | 'collection'), the total
-- gp value (informational / for the Discord feed), and the consumer's verdict once it
-- runs: 'credited' | 'no_tile' | 'no_user' | 'timing' | 'duplicate' | 'partial'
-- (NULL = not yet processed). `outcome` powers the admin "why didn't I get credit?" view.
alter table vs_dink_drops add column if not exists notif_type text not null default 'loot';
alter table vs_dink_drops add column if not exists value bigint;
alter table vs_dink_drops add column if not exists outcome text;
create index if not exists vs_dink_drops_outcome on vs_dink_drops (outcome);

-- ----------------------------------------------------------------------------
-- Manifest the proxy reads (cheap, cacheable). The Worker matches a LOOT drop
-- when playerName ∈ vs_active_participants AND the item ∈ vs_active_tracked_items.
-- ----------------------------------------------------------------------------
-- item_name kept in its original casing so the proxy can both case-insensitively
-- match drops AND inject the names into Dink's loot allowlist (which displays them).
create or replace view vs_active_tracked_items as
select ti.event_id,
       e.slug as event_slug,
       ti.tile_id,
       ti.item_id,
       ti.item_name,
       ti.required_qty,
       ti.source_name,
       ti.match_type
from vs_event_tracked_items ti
join vs_events e on e.id = ti.event_id
where e.status = 'open';

-- Participant RSNs (lowercased): the whole clan roster (bingo is clan-wide) plus
-- anyone signed up to an open event. The tracked-item set is what actually gates.
create or replace view vs_active_participants as
select distinct lower(rsn) as rsn
from players
where rsn is not null and length(trim(rsn)) > 0
union
select distinct lower(u.rsn) as rsn
from vs_event_signups s
join vs_events e on e.id = s.event_id and e.status = 'open'
join vs_users u on u.id = s.user_id
where u.rsn is not null and length(trim(u.rsn)) > 0;
