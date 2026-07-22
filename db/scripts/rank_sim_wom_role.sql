-- Cache each member's WOM group role on their vs_rank_sim row.
--
-- The rank-sim live comparison needs every member's current in-game rank (their WOM group
-- role). It used to read that from a live WOM roster call, which gets rate-limited after a
-- big refresh sweep ("WOM clan roster unavailable"). The refresh already fetches the roster,
-- so we now cache the role here and the comparison reads it from the cache — no live WOM
-- call, and it's instant like the summary.
--
-- Idempotent; safe to re-run. Apply in the Supabase SQL editor (no migration runner).
alter table if exists vs_rank_sim add column if not exists wom_role text;

-- Reload PostgREST's schema cache so the new column is queryable immediately.
notify pgrst, 'reload schema';
