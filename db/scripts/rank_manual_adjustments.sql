-- Manual rank adjustments: the staff escape hatch for members the automated scoring
-- can't score correctly.
--
-- Two independent mechanisms, both deliberately admin-only and both fully attributed:
--
--   1. vs_rank_overrides — per-member adjustments to the SCORING INPUTS (and, at the
--      far end, a hard pin of the final rank). The motivating case: group ironmen
--      hold the Grandmaster combat-achievement tier without completing every task, so
--      WikiSync's task list understates their CA component and nothing in the code can
--      tell the difference. An admin sets `ca_tier_override = 'grandmaster'` and the
--      component scores as it should.
--
--   2. vs_rank_item_claims.source / .quantity — admins can GRANT a gear item outright
--      (any gear-table item, not just the `claimable: true` ones members may submit),
--      with a count. The motivating case: a member who got four Zenyte shards before
--      the in-game collection log existed has no log entry to prove them, and the four
--      shard entries in the gear table are quantity checks, so a count is required.
--
-- Members can NEVER reach either of these — the site exposes them under /admin/ranks
-- only, every write lands in vs_audit_log automatically (POSTs under /admin/**), and
-- both carry a mandatory reason plus who set it.
--
-- Apply by hand in the Supabase SQL editor, or with db/apply.sh (idempotent).

-- 1. Per-member scoring overrides ------------------------------------------------
create table if not exists vs_rank_overrides (
	id bigint generated always as identity primary key,
	-- Keyed by RSN (lowercased on write), because scoring runs by RSN and the roster
	-- includes members with no site account at all (the mass update scores them from
	-- WOM alone). user_id / discord_id are carried for display + linking only.
	rsn text not null unique,
	display_rsn text,
	user_id uuid references vs_users(id) on delete set null,
	discord_id text,

	-- Hard pin: when set, this womRole IS the member's rank, whatever the composite
	-- says. Everything else below adjusts the INPUTS and lets the formula decide.
	rank_override text,

	-- Treat the member as having banked every combat-achievement tier reward up to and
	-- including this tier ('easy'…'grandmaster'). Only ever raises the CA component.
	ca_tier_override text,

	-- Additive nudges to the raw inputs (may be negative). Applied before normalization,
	-- so they respect the configured caps and curves like any other progress.
	gear_points_bonus integer not null default 0,
	ehb_bonus numeric not null default 0,
	clog_bonus integer not null default 0,
	months_bonus numeric not null default 0,
	-- Replaces the fetched total level outright (null = use the fetched value).
	total_level_override integer,

	-- Why this exists. Required: an unexplained override is the thing this table is
	-- meant to prevent.
	reason text not null,
	created_by uuid references vs_users(id),
	created_at timestamptz not null default now(),
	updated_at timestamptz not null default now()
);

create index if not exists vs_rank_overrides_user on vs_rank_overrides (user_id);

-- 2. Admin-granted gear items ----------------------------------------------------
-- 'member' = submitted through the /me claim modal (restricted to gear-table entries
-- flagged claimable, always quantity 1). 'admin' = granted outright from
-- /admin/ranks/adjustments, over the WHOLE gear table, with a count.
alter table vs_rank_item_claims
	add column if not exists source text not null default 'member';

alter table vs_rank_item_claims
	add column if not exists quantity integer not null default 1;

do $$
begin
	if not exists (
		select 1 from pg_constraint where conname = 'vs_rank_item_claims_source_check'
	) then
		alter table vs_rank_item_claims
			add constraint vs_rank_item_claims_source_check check (source in ('member', 'admin'));
	end if;
end $$;

-- Deny-all RLS, same posture as every vs_ table (see enable_rls.sql): the site reads
-- and writes via service_role only.
alter table vs_rank_overrides enable row level security;

-- PostgREST caches the schema; without this the new table/columns 404 until restart.
notify pgrst, 'reload schema';
