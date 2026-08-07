-- Retune a live Battleship event's bomb tiers, and re-score the bombs already banked
-- against the old numbers.
--
-- Written for the 2026-08-07 live event, whose pace turned out slower than planned:
-- 5m / 25m / 50m  →  5m / 20m / 60m. It is parameterised, so it is the script to reach
-- for any time the tiers need to move mid-event.
--
--
-- ── WHY TWO THINGS HAVE TO CHANGE TOGETHER ───────────────────────────────────
--
-- `vs_battleship_arsenal` stores a bomb's TIER NUMBER (1/2/3), not its span. The span is
-- looked up from the event's config at the moment it is fired:
--
--     const tier = snap.config.tiers.find((t) => t.tier === bomb.tier)   (fireBomb)
--
-- So changing a tier's `span` retroactively resizes every banked bomb of that tier for
-- free. Changing a tier's `min_value` does NOT: the tier number was decided by
-- `tierForValue` when the drop landed and is frozen in the row. A 22m drop banked under
-- the old numbers is a tier-1 Cannonball forever unless something re-scores it. That
-- something is step 2 below.
--
-- Update the tiers and skip the re-score and the arsenal openly contradicts the rules the
-- page is displaying: two players holding 22m drops, one with a 2x2 because they got it
-- after the change and one with a 1x1 because they got it before. Hence one transaction.
--
--
-- ── NOBODY GETS DEMOTED ──────────────────────────────────────────────────────
--
-- Raising a floor (50m → 60m here) means a banked 55m drop no longer clears tier 3 on the
-- new numbers. Re-scoring it strictly would take a 3x3 off someone who has been sitting on
-- it — mid-event, for a rule change they did not ask for. The re-score therefore takes
--
--     greatest(current tier, tier the new numbers give it)
--
-- so it only ever moves bombs UP. If you genuinely want a strict re-score that can demote,
-- drop the `greatest(...)` and compare against `a.tier` directly — but say so publicly
-- first, because it is taking ammunition away.
--
-- FIRED bombs are left alone regardless (`spent_at is null`). Their craters are already on
-- the board; re-scoring one would mean the row claims a 3x3 that only ever cut a 2x2.
--
-- ADMIN GRANTS are left alone too (`source <> 'admin'`). `grantBomb` writes `value: 0`
-- with the tier chosen by hand, so re-scoring by value would knock every make-good grant
-- down to nothing.
--
--
-- ── WHAT DOES NOT NEED TOUCHING ──────────────────────────────────────────────
--
--   * The dink-proxy. It reads `vs_value_tracked_rsns`, whose gp floor is
--     `tiers[0].min_value` — tier 1 stays at 5m below, so the floor is unchanged and no
--     redeploy is involved. If you ever move TIER 1, the proxy starts recording at the new
--     floor on its next manifest refresh, with no deploy either.
--   * The site. The event page renders the rates straight off `config.tiers`, so this
--     script alone changes what players are told.
--   * The event's prose `description`, which this script CANNOT know about. If it quotes
--     gp numbers, the preflight prints it — fix it by hand.
--
--
-- ── RUN THIS BEFORE THE DEPLOY, NOT AFTER ───────────────────────────────────
--
-- `configFrom` falls back to `DEFAULT_TIERS` when the event has no explicit
-- `structure.battleship.tiers`. So for an event created without them, shipping a change
-- to that constant IS a rules change — applied instantly, to a live game, with no
-- re-score behind it. Every banked bomb would keep the tier the old constant gave it
-- while the page displayed the new numbers.
--
-- Running this script first closes that door: it writes the tiers EXPLICITLY, so the
-- constant stops mattering for this event, and re-scores in the same transaction. The
-- deployed code already reads `structure.battleship.tiers` — it has since the event
-- shipped — so the new numbers take effect the moment this commits, deploy or no deploy.
-- The only thing the deploy adds is showing the rates to players who are holding a bomb.
--
-- If the preflight shows the event already has explicit tiers, the order does not matter.
-- Running this first is correct either way, so just do that.
--
-- ── PREFLIGHT: run this first, on its own. It changes nothing. ───────────────
--
--   select e.slug,
--          e.structure -> 'battleship' -> 'tiers' as tiers_now,
--          e.description
--   from vs_events e
--   where e.slug = 'battleship' and e.kind = 'battleship';
--
--   -- What the re-score would do, before doing it:
--   select a.tier as tier_now,
--          count(*),
--          min(a.value) as min_gp, max(a.value) as max_gp
--   from vs_battleship_arsenal a
--   join vs_events e on e.id = a.event_id
--   where e.slug = 'battleship' and a.spent_at is null and coalesce(a.source, '') <> 'admin'
--   group by a.tier order by a.tier;
--
-- ────────────────────────────────────────────────────────────────────────────

begin;

-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║  SET THESE: the event, and the new tiers.                                ║
-- ║                                                                          ║
-- ║  Keep them ordered cheapest-first — `vs_value_tracked_rsns` reads         ║
-- ║  tiers[0] to decide the proxy's gp floor.                                 ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
create temporary table _target on commit drop as
select id from vs_events where slug = 'battleship' and kind = 'battleship';

create temporary table _tiers on commit drop as
select '[
	{"tier": 1, "name": "Cannonball", "min_value": 5000000,  "span": 1},
	{"tier": 2, "name": "Bombard",    "min_value": 20000000, "span": 2},
	{"tier": 3, "name": "Broadside",  "min_value": 60000000, "span": 3}
]'::jsonb as tiers;

-- Abort the whole transaction unless exactly one event matched and the tiers are sane.
-- A typo here would mis-price every bomb in a live game.
do $$
declare n int; t jsonb; prev bigint := -1; e jsonb;
begin
	select count(*) into n from _target;
	if n <> 1 then
		raise exception 'expected _target to match exactly 1 battleship event, found %', n;
	end if;

	select tiers into t from _tiers;
	if jsonb_array_length(t) = 0 then
		raise exception 'no tiers given — an empty array would fall back to DEFAULT_TIERS';
	end if;
	for e in select * from jsonb_array_elements(t) loop
		if (e ->> 'min_value')::bigint <= prev then
			raise exception
				'tiers must be ordered cheapest-first (vs_value_tracked_rsns reads tiers[0]); got % after %',
				e ->> 'min_value', prev;
		end if;
		prev := (e ->> 'min_value')::bigint;
		if (e ->> 'span')::int < 1 then
			raise exception 'tier % has a span below 1', e ->> 'tier';
		end if;
	end loop;
end $$;

-- ── 1. The rules ────────────────────────────────────────────────────────────
-- jsonb_set on the ONE key, so every other structure key (phase, size,
-- placement_ends_at, draft bookkeeping) survives untouched. `true` creates
-- `tiers` if the event was created without an explicit one and has been running
-- on DEFAULT_TIERS.
update vs_events e
set structure = jsonb_set(
		coalesce(e.structure, '{}'::jsonb),
		'{battleship,tiers}',
		(select tiers from _tiers),
		true
	)
where e.id in (select id from _target);

-- ── 2. The bombs already banked ─────────────────────────────────────────────
-- Every unfired, non-granted bomb is re-scored against the new numbers, upward only.
update vs_battleship_arsenal a
set tier = greatest(
		a.tier,
		coalesce(
			(
				select max((t ->> 'tier')::int)
				from jsonb_array_elements((select tiers from _tiers)) t
				where a.value >= (t ->> 'min_value')::bigint
			),
			a.tier   -- under even the cheapest new floor: leave it exactly as it is
		)
	)
where a.event_id in (select id from _target)
  and a.spent_at is null
  and coalesce(a.source, '') <> 'admin';

commit;

-- ── VERIFY (run after) ──────────────────────────────────────────────────────
--
--   select e.structure -> 'battleship' -> 'tiers' as tiers_now
--   from vs_events e where e.slug = 'battleship';
--
--   select a.tier, count(*), min(a.value) as min_gp, max(a.value) as max_gp
--   from vs_battleship_arsenal a
--   join vs_events e on e.id = a.event_id
--   where e.slug = 'battleship' and a.spent_at is null
--   group by a.tier order by a.tier;
--
-- Rows sitting ABOVE what the new numbers give them are expected — that is `greatest`
-- protecting someone from a raised floor. Rows sitting BELOW would mean the re-score
-- missed them, and this returns them (expected: 0 rows):
--
--   select a.id, a.tier, a.value, a.item_name
--   from vs_battleship_arsenal a
--   join vs_events e on e.id = a.event_id
--   where e.slug = 'battleship' and a.spent_at is null and coalesce(a.source,'') <> 'admin'
--     and a.tier < coalesce((
--           select max((x ->> 'tier')::int)
--           from jsonb_array_elements(e.structure #> '{battleship,tiers}') x
--           where a.value >= (x ->> 'min_value')::bigint
--         ), a.tier);
