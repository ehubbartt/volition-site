-- volition-site initial schema
-- Run this in the Supabase SQL Editor for the bot's project.
-- All site tables use the `vs_` (volition-site) prefix to keep them
-- visually separated from the bot's tables (players, tile_event_*, etc.).

-- ============================================================
-- Users
-- ============================================================
create table if not exists vs_users (
    id               uuid primary key default gen_random_uuid(),
    discord_id       text unique not null,
    discord_username text not null,
    rsn              text,
    clan_allegiance  text check (
        clan_allegiance in ('volition', 'iron_refuge', 'reborn_iron', 'other_mixed')
    ),
    created_at       timestamptz not null default now(),
    updated_at       timestamptz not null default now()
);

create unique index if not exists vs_users_rsn_lower_idx
    on vs_users (lower(rsn))
    where rsn is not null;

-- ============================================================
-- Events
-- ============================================================
create table if not exists vs_events (
    id                uuid primary key default gen_random_uuid(),
    slug              text unique not null,
    name              text not null,
    description       text,
    team_size         int  not null default 2,
    status            text not null default 'open'
        check (status in ('draft', 'open', 'locked', 'closed')),
    signup_opens_at   timestamptz,
    signup_closes_at  timestamptz,
    created_at        timestamptz not null default now()
);

-- ============================================================
-- Teams (created when an invite is accepted)
-- ============================================================
create table if not exists vs_teams (
    id          uuid primary key default gen_random_uuid(),
    event_id    uuid not null references vs_events(id) on delete cascade,
    name        text,
    created_by  uuid not null references vs_users(id),
    created_at  timestamptz not null default now()
);

-- ============================================================
-- Event signups (one row per user per event they've joined)
-- ============================================================
create table if not exists vs_event_signups (
    id         uuid primary key default gen_random_uuid(),
    event_id   uuid not null references vs_events(id) on delete cascade,
    user_id    uuid not null references vs_users(id)  on delete cascade,
    team_id    uuid     references vs_teams(id)       on delete set null,
    joined_at  timestamptz not null default now(),
    unique (event_id, user_id)
);

create index if not exists vs_event_signups_event_idx     on vs_event_signups(event_id);
create index if not exists vs_event_signups_event_team_idx on vs_event_signups(event_id, team_id);

-- ============================================================
-- Team invites
-- ============================================================
create table if not exists vs_team_invites (
    id            uuid primary key default gen_random_uuid(),
    event_id      uuid not null references vs_events(id) on delete cascade,
    from_user_id  uuid not null references vs_users(id)  on delete cascade,
    to_user_id    uuid not null references vs_users(id)  on delete cascade,
    status        text not null default 'pending'
        check (status in ('pending', 'accepted', 'declined', 'cancelled')),
    created_at    timestamptz not null default now(),
    responded_at  timestamptz,
    check (from_user_id <> to_user_id)
);

-- Only one pending invite can exist between a given (event, from, to) pair at a time.
create unique index if not exists vs_team_invites_pending_uniq
    on vs_team_invites (event_id, from_user_id, to_user_id)
    where status = 'pending';

create index if not exists vs_team_invites_to_pending_idx
    on vs_team_invites (event_id, to_user_id)
    where status = 'pending';

create index if not exists vs_team_invites_from_pending_idx
    on vs_team_invites (event_id, from_user_id)
    where status = 'pending';

-- ============================================================
-- Sessions (server-side session store, cookie holds the row id)
-- ============================================================
create table if not exists vs_sessions (
    id          text primary key,
    user_id     uuid not null references vs_users(id) on delete cascade,
    expires_at  timestamptz not null,
    created_at  timestamptz not null default now()
);

create index if not exists vs_sessions_user_idx on vs_sessions(user_id);
create index if not exists vs_sessions_expires_idx on vs_sessions(expires_at);

-- ============================================================
-- updated_at trigger for vs_users
-- ============================================================
create or replace function vs_set_updated_at() returns trigger as $$
begin
    new.updated_at = now();
    return new;
end;
$$ language plpgsql;

drop trigger if exists vs_users_updated_at on vs_users;
create trigger vs_users_updated_at
    before update on vs_users
    for each row execute function vs_set_updated_at();
