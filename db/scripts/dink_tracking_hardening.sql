-- Dink auto-tracking hardening. Apply by hand in the Supabase SQL editor (no
-- migration runner). Safe to re-run. Dink auto-tracking is not live in prod yet, so
-- these can be applied at any time before it's enabled.
--
-- Why each change:
--   1. vs_dink_drops.tile_id — attribute every credited/partial drop to the specific
--      tile it counted toward, so collect-N progress for two tiles tracking the SAME
--      item no longer pools, and so a credit can mark exactly its own partials consumed.
--   2. vs_bingo_completions.source — tag auto-credits ('dink') so a revert can find them
--      by a real column instead of matching the human-readable review_note text.
--   3. unique partial index — guarantee at most one approved completion per
--      (event, user, tile). With it, concurrent/multi-instance processing can't
--      double-credit: the second insert raises a unique violation the consumer treats
--      as 'duplicate'. (Will FAIL if duplicate approved rows already exist — de-dupe
--      first if so; in a fresh/empty dink dataset there are none.)

alter table vs_dink_drops add column if not exists tile_id text;

alter table vs_bingo_completions add column if not exists source text;

create unique index if not exists vs_bingo_completions_one_approved
	on vs_bingo_completions (event_id, user_id, tile_id)
	where status = 'approved';
