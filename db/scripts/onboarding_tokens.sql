-- Site-owned new-member onboarding sessions (Version B: the site reproduces the
-- Discord join phase; the link the bot DMs lands here). One row == one onboarding
-- run == one unique link. The flow is RESUMABLE (not consume-once): reopening the
-- link reloads the in-progress session for the same member, gated by expiry and by
-- the signed-in user's discord_id matching the row.
--
-- Apply by hand in the Supabase SQL editor (idempotent). Shared DB with the bot,
-- which mints rows here from the /onboard-test-a|b admin commands.

create table if not exists vs_onboarding_tokens (
	token text primary key,
	-- Who the link is for (the bot knows this when it mints). The site binds the row
	-- to the matching vs_users row on first open and refuses a mismatched session.
	discord_id text not null,
	variant text not null default 'b' check (variant in ('a', 'b')),
	user_id uuid references vs_users(id) on delete set null,
	-- Progress: the step the member is on + the set of finished step ids. `data` is
	-- per-step scratch (e.g. the captured introduction, verified RSN/EHB).
	current_step text,
	completed_steps jsonb not null default '[]'::jsonb,
	data jsonb not null default '{}'::jsonb,
	created_by text, -- admin discord id who minted it (test provenance)
	created_at timestamptz not null default now(),
	expires_at timestamptz not null default now() + interval '14 days',
	started_at timestamptz, -- first successful open
	completed_at timestamptz -- reached the final step
);

create index if not exists vs_onboarding_tokens_discord on vs_onboarding_tokens (discord_id);

-- RLS is intentionally left DISABLED here. This table is written by BOTH the site
-- (service_role, which bypasses RLS) AND the Discord bot's /onboard-test commands.
-- The bot connects with the Supabase key it has in this deploy — the anon key in the
-- current pre-lockdown state — so a deny-all policy would block the bot's INSERT
-- ("new row violates row-level security policy"). This matches the bot's other shared
-- tables (players, dink_tokens), which are also not RLS-enforced. When the full RLS
-- lockdown lands (the bot switched to the service_role key — see docs/PENDING-OPS),
-- re-enable it: `alter table vs_onboarding_tokens enable row level security;`.
alter table vs_onboarding_tokens disable row level security;

-- PostgREST caches the schema; without this the new table 404s until restart.
notify pgrst, 'reload schema';
