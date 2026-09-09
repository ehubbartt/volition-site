-- Dink delivery MODES, and member-owned relay destinations.
--
-- Background: the proxy makes two independent decisions for every notification —
-- it RECORDS matched drops for event tracking regardless of value, and it FORWARDS
-- to the Volition Discord only when a single stack clears FEED_MIN_VALUE. The
-- config's minLootValue only controls what Dink bothers to SEND us. So a low
-- threshold never spams our own feed; what it does spam is any OTHER Discord the
-- member has pointed their own Dink at, because those webhooks are configured in
-- their client and bypass this proxy entirely.
--
-- Two INDEPENDENT questions fall out of that, and conflating them into one enum
-- cannot express "visiting player who still wants their own clan's feed":
--
--   mode          how much Dink sends us, and who else we post to on their behalf
--     standard      minLootValue 1. They imported our config and left it alone, so
--                   Dink posts to us and nobody else. Zero maintenance, best tracking.
--     multi_server  They re-added their OWN webhooks to Dink after importing, so a low
--                   threshold would fire those on every drop. HIGH minLootValue; their
--                   tracked items ride the injected allowlist instead. Costs them a
--                   plugin toggle whenever their tiles change.
--     relay         They did NOT re-add their own webhooks — they registered them with
--                   us (vs_dink_relays) instead. Keeps minLootValue 1 (so tracking is
--                   perfect and nothing needs toggling) while we fan out to their
--                   destinations with each one's own value floor and type set.
--
--   forward_clan  whether the proxy posts this member's notifications to the VOLITION
--                 Discord at all. True for members; false for a visiting clan's player,
--                 whose drops are recorded for the event and never appear in our feed.
--
-- Orthogonal on purpose: a visitor on `relay` gets event tracking, silence in our
-- Discord, and their own clan's channel still fed.
--
-- `multi_server` (the legacy boolean) is kept in sync by the site so the existing proxy
-- path and the Discord bot keep working during a rollout; `mode` is the authority.
--
-- Apply by hand in the Supabase SQL editor (no migration runner). Idempotent.

alter table public.dink_tokens
	add column if not exists mode text not null default 'standard';
alter table public.dink_tokens
	add column if not exists forward_clan boolean not null default true;

-- Backfill from the legacy flag before the constraint lands, so an existing
-- multi-server member is not rewritten to 'standard' on their next visit.
update public.dink_tokens set mode = 'multi_server'
	where multi_server = true and mode = 'standard';

alter table public.dink_tokens drop constraint if exists dink_tokens_mode_check;
alter table public.dink_tokens add constraint dink_tokens_mode_check
	check (mode in ('standard', 'multi_server', 'relay'));

-- ---------------------------------------------------------------------------
-- Relay destinations: a member's OWN Discord webhooks, which the proxy posts to on
-- their behalf so they can keep minLootValue 1 without their other servers seeing
-- every 1gp drop.
--
-- `url` is a secret in the same sense a webhook always is — anyone holding it can
-- post to that channel — so it is never rendered back to the page in full and never
-- logged by the proxy. The CHECK is a defence-in-depth SSRF guard: the application
-- validates the URL too, but the database refuses to store anything that isn't a
-- Discord webhook, so a bug upstream cannot turn this table into a request cannon.
--
-- `min_value` is the per-destination floor in GP, judged per stack exactly like the
-- clan feed. `types` is the notification set that destination accepts, from the
-- proxy's FORWARD_TYPES.
-- ---------------------------------------------------------------------------
create table if not exists vs_dink_relays (
	id          uuid primary key default gen_random_uuid(),
	discord_id  text not null,
	label       text,
	url         text not null,
	min_value   bigint not null default 3000000 check (min_value >= 0),
	types       text[] not null default array['LOOT','COLLECTION','PET','DEATH'],
	enabled     boolean not null default true,
	created_at  timestamptz not null default now(),
	constraint vs_dink_relays_url_is_discord
		check (url ~ '^https://(canary\.|ptb\.)?discord(app)?\.com/api/webhooks/[0-9]+/[A-Za-z0-9_-]+$')
);

-- The proxy looks these up by the member behind a token, so index the join column.
create index if not exists vs_dink_relays_discord on vs_dink_relays (discord_id) where enabled;

-- One member should not be able to register the same destination twice.
create unique index if not exists vs_dink_relays_unique on vs_dink_relays (discord_id, url);
