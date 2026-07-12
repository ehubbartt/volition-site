-- vs_rank_sim — cached per-player rank-scoring inputs + piece-level detail.
-- Written by the admin rank-sim REFRESH (/admin/rank-sim) and by each member's
-- "Check my rank" on /me; read by buildMeData for the /me Rank tab breakdown.
-- Apply by hand in the Supabase SQL editor (no migration runner). Idempotent.

create table if not exists public.vs_rank_sim (
	rsn text primary key,
	wom_id bigint,
	ehb integer,
	total_level integer,
	gear_points numeric,
	clog_finished integer,
	clog_available integer,
	months_in_clan numeric,
	ca_points numeric,
	temple_available boolean,
	wikisync_available boolean,
	ca_tier text,
	gear_detail jsonb,
	ca_detail jsonb,
	fetched_at timestamptz
);

-- The two detail columns were added after the table first shipped (they hold the
-- gear grid + CA stats the /me Rank tab renders); make sure existing DBs get them.
alter table public.vs_rank_sim add column if not exists gear_detail jsonb;
alter table public.vs_rank_sim add column if not exists ca_detail jsonb;

-- New columns need a PostgREST schema-cache reload before the API sees them.
notify pgrst, 'reload schema';
