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
--   3. unique partial index — guarantee at most one approved DINK auto-credit per
--      (event, user, tile), so concurrent/multi-instance processing can't double-credit
--      (the second insert raises a unique violation the consumer treats as 'duplicate').
--      It is scoped to `source = 'dink'` ON PURPOSE: manual completions legitimately have
--      MULTIPLE approved rows per tile (collect-N tiles where a player submits proof N
--      times, each approved), so a blanket unique index on (event,user,tile) would break
--      those. Manual rows have source IS NULL and are left unconstrained; only Dink rows
--      are deduped. Creates cleanly even on a DB with manual collect-N duplicates (there
--      are no source='dink' rows until Dink runs).

alter table vs_dink_drops add column if not exists tile_id text;

-- These ship in the hand-applied event_builder.sql, but older databases predate them and
-- the consumer/simulator read+write them (notif_type routes loot vs collection matching;
-- outcome stores the per-drop verdict). Additive + idempotent.
alter table vs_dink_drops add column if not exists notif_type text not null default 'loot';
alter table vs_dink_drops add column if not exists outcome text;
-- gp value of the drop (from the proxy); shown in the /admin/dink-drops debug view.
alter table vs_dink_drops add column if not exists value bigint;
-- Public URL of the Dink screenshot for this drop (uploaded to vs-bingo-proofs by the
-- proxy when the client attached one). The consumer copies it into the credited
-- submission's proof_urls so the drop image doubles as reviewable proof.
alter table vs_dink_drops add column if not exists image_url text;

alter table vs_bingo_completions add column if not exists source text;

-- Drop the earlier (wrong) blanket index name if a prior attempt created it anywhere.
drop index if exists vs_bingo_completions_one_approved;

create unique index if not exists vs_bingo_completions_one_dink_approved
	on vs_bingo_completions (event_id, user_id, tile_id)
	where status = 'approved' and source = 'dink';
