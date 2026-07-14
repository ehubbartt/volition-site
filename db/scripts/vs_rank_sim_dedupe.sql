-- vs_rank_sim — remove case/underscore-variant duplicate rows for the same player.
--
-- The table is keyed by rsn (primary key, CASE-SENSITIVE), but two writers used
-- different spellings: the admin rank-sim REFRESH keys rows by the WOM canonical
-- rsn, while "Check my rank" on /me keyed them by the member's profile rsn. A
-- member whose profile spelling differed in case (or used '_' for a space) ended
-- up with TWO rows — and the Rank tab's case-insensitive read errored on the
-- multi-row match and showed nothing.
--
-- The site now reads freshest-first (tolerates duplicates) and reuses the existing
-- row's key on write (stops creating new ones); this script cleans up the rows that
-- already exist. Keeps the most recently fetched row per normalized rsn.
--
-- Apply by hand in the Supabase SQL editor (no migration runner). Idempotent.

delete from public.vs_rank_sim a
using public.vs_rank_sim b
where a.rsn <> b.rsn
  and lower(replace(a.rsn, '_', ' ')) = lower(replace(b.rsn, '_', ' '))
  and (
    coalesce(a.fetched_at, 'epoch'::timestamptz) < coalesce(b.fetched_at, 'epoch'::timestamptz)
    or (
      coalesce(a.fetched_at, 'epoch'::timestamptz) = coalesce(b.fetched_at, 'epoch'::timestamptz)
      and a.rsn < b.rsn
    )
  );
