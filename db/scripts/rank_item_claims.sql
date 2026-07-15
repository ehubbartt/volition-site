-- Manual gear claims for rank scoring. Some gear-table items can't be proven by the
-- Temple collection log (tradeable pieces bought on the GE, upgraded variants like
-- Blood Torva / Radiant Oathplate combined outside the log) — the member submits a
-- claim with proof screenshots, an admin reviews it on /admin/rank-claims, and
-- APPROVED claims merge into calculateGearPoints as if the item were in their log.
--
-- Apply by hand in the Supabase SQL editor (idempotent).

create table if not exists vs_rank_item_claims (
	id bigint generated always as identity primary key,
	user_id uuid not null references vs_users(id) on delete cascade,
	-- The gear-table CHECK item name being claimed (e.g. 'Oathplate chest') — validated
	-- server-side against gearScoring.json's flattened item list.
	item_name text not null,
	proof_urls jsonb not null default '[]'::jsonb,
	note text,
	status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
	review_note text,
	reviewed_by uuid references vs_users(id),
	submitted_at timestamptz not null default now(),
	reviewed_at timestamptz
);

create index if not exists vs_rank_item_claims_user   on vs_rank_item_claims (user_id, status);
create index if not exists vs_rank_item_claims_status on vs_rank_item_claims (status, submitted_at);

-- Deny-all RLS, same posture as every vs_ table (see enable_rls.sql): the site reads
-- and writes via service_role only.
alter table vs_rank_item_claims enable row level security;

-- PostgREST caches the schema; without this the new table 404s until restart.
notify pgrst, 'reload schema';
