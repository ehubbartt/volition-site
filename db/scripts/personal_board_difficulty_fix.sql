-- Personal bingo: audit + fix boards whose difficulty overstates their tiles.
--
-- The keep-line reroll used to let a player hold a row/column generated at an easy
-- difficulty, raise the difficulty dial, and reroll — the held easy tiles stayed
-- while the board's VP (which scales with structure->>'difficulty') jumped. The
-- generator now drops the held line when the difficulty changes; this script deals
-- with boards that already slipped through.
--
-- Approach: recompute each LOCKED, non-test board's EFFECTIVE difficulty — the
-- highest difficulty whose generation floors every tile on the board actually
-- clears — and lower structure->>'difficulty' to it where it's lower than what's
-- stored. VP settlement reads the structure live, so any lines completed AFTER the
-- update pay at the corrected rate; VP already paid out stays paid (section 3 lists
-- it for manual clawback via /admin if you want).
--
-- Floors mirror src/lib/server/personalBoard.ts + src/lib/ehp.ts:
--   item tile:  ehb >= 0.1 * (d-1)^2                                  (minTileEhb)
--   skill tile: hours >= 0.85 * (0.5 + 0.5d + 0.2d^2) * (0.12 + 0.04(d-1))
--               (skillTileHours' lowest band, with 0.85 slack for its -15% jitter)
--   CA tiles have no numeric floor — skipped.
--
-- CAVEATS — review section 1 before running section 2:
--  * Boards locked BEFORE the difficulty floors shipped can flag legitimately.
--  * Near-complete logs use a fallback that legitimately places sub-floor items
--    (the player's hardest remaining ones). Those boards read as "overpriced" here
--    but weren't exploited. If in doubt, compare locked_at with the reroll history
--    you'd expect from the player.
--
-- Apply by hand in the Supabase SQL editor (no migration runner). Idempotent.

-- ── 1. AUDIT: locked boards whose effective difficulty is below the stored one ──
with boards as (
	select e.id, e.slug, e.structure->>'rsn' as rsn,
	       (e.structure->>'size')::int as size,
	       (e.structure->>'difficulty')::int as difficulty,
	       e.locked_at
	from public.vs_events e
	where e.kind = 'personal'
	  and e.locked_at is not null
	  and coalesce(e.structure->>'test', 'false') <> 'true'
),
eff as (
	select b.id, max(d.d) as effective_difficulty
	from boards b
	cross join generate_series(1, 10) as d(d)
	where not exists (
		select 1 from public.vs_tiles t
		where t.event_id = b.id
		  and (
			(t.kind = 'item' and (t.meta->>'ehb')::numeric < 0.1 * (d.d - 1) * (d.d - 1))
			or
			(t.kind = 'skill' and (t.meta->>'ehb')::numeric <
				0.85 * (0.5 + 0.5 * d.d + 0.2 * d.d * d.d) * (0.12 + 0.04 * (d.d - 1)))
		  )
	)
	group by b.id
)
select b.rsn, b.size, b.difficulty as stored_difficulty,
       eff.effective_difficulty, b.locked_at, b.id
from boards b
join eff on eff.id = b.id
where eff.effective_difficulty < b.difficulty
order by b.difficulty - eff.effective_difficulty desc;

-- ── 2. FIX: lower structure->>'difficulty' to the effective difficulty ──────────
-- Same computation as the audit; only ever lowers, never raises. Run AFTER
-- reviewing section 1 (delete specific ids from the audit output? add
--   `and e2.id in ('…')`
-- to the final where-clause to fix only the boards you've eyeballed).
with boards as (
	select e.id, (e.structure->>'difficulty')::int as difficulty
	from public.vs_events e
	where e.kind = 'personal'
	  and e.locked_at is not null
	  and coalesce(e.structure->>'test', 'false') <> 'true'
),
eff as (
	select b.id, max(d.d) as effective_difficulty
	from boards b
	cross join generate_series(1, 10) as d(d)
	where not exists (
		select 1 from public.vs_tiles t
		where t.event_id = b.id
		  and (
			(t.kind = 'item' and (t.meta->>'ehb')::numeric < 0.1 * (d.d - 1) * (d.d - 1))
			or
			(t.kind = 'skill' and (t.meta->>'ehb')::numeric <
				0.85 * (0.5 + 0.5 * d.d + 0.2 * d.d * d.d) * (0.12 + 0.04 * (d.d - 1)))
		  )
	)
	group by b.id
)
update public.vs_events e2
set structure = jsonb_set(e2.structure, '{difficulty}', to_jsonb(eff.effective_difficulty))
from boards b
join eff on eff.id = b.id
where e2.id = b.id
  and eff.effective_difficulty < b.difficulty;

-- ── 3. VP already paid on flagged boards (for manual review / clawback) ─────────
-- Lines settled BEFORE the fix were paid at the inflated rate. Each row below is a
-- vs_submissions VP ledger entry (quantity = VP granted). If you want it back,
-- adjust the member's points via the bot/admin tools; deleting the ledger row would
-- make the line settle AGAIN at the corrected rate, so prefer a points adjustment.
select e.structure->>'rsn' as rsn, s.target_id, s.quantity as vp_paid,
       s.submitted_at, e.id as board_id
from public.vs_submissions s
join public.vs_events e on e.id = s.event_id
where s.source = 'vp'
  and s.status = 'approved'
  and e.kind = 'personal'
order by s.submitted_at desc;
