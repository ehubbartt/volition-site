-- ONE-OFF REPAIR for the live `battleship` event on PROD, 2026-08-07.
--
-- What happened: the event was launched from `main`, which predates two fixes.
--   1. `CELLS_PER_PLAYER = 6` sized 85 signups onto a 17x17 board. The current dial
--      (15) puts the same crowd on 25x25.
--   2. `canSeeFleet = viewer.isAdmin || ...` handed BOTH fleets to every admin, so any
--      admin — including the captains — could read their opponent's board.
--
-- The draft is fine and is NOT touched. Placement has to be redone regardless: a leaked
-- fleet cannot be un-seen, so the only real remedy is new ship positions.
--
-- WHY THE SIZE IS PINNED HERE. On the deployed code the board size is recomputed on
-- every read (`bs.size ?? boardSizeFor(perSide)`) and stored nowhere. Ship the fix
-- without this and the board silently becomes 25x25 while the fleets already in the
-- database stay 14 ships crammed into the top-left 17x17 corner — 336 squares that can
-- never be hit. Pinning it makes the deploy a no-op for board size. Both the old and the
-- new code honour `structure.battleship.size`, so deploy order does not affect
-- correctness; running this FIRST is still preferable, because it leaves no window where
-- a placed fleet disagrees with the board under it.
--
-- SAFE TO RUN because the event has fired 0 shots and banked 0 bombs — nobody loses
-- progress. The shot/arsenal handling below is defensive, for anything that lands
-- between reading that and running this.
--
-- ── RUN THE PREFLIGHT FIRST, ON ITS OWN ─────────────────────────────────────
-- Paste just this and read it before running the rest. It changes nothing.
--
--   select e.slug,
--          e.structure -> 'battleship' ->> 'phase' as phase,
--          e.structure -> 'battleship' ->> 'size'  as pinned_size,
--          (select count(*) from vs_battleship_shots   s where s.event_id = e.id) as shots,
--          (select count(*) from vs_battleship_arsenal a where a.event_id = e.id) as bombs,
--          (select count(*) from vs_event_signups      g where g.event_id = e.id) as signed_up
--   from vs_events e
--   where e.slug = 'battleship' and e.kind = 'battleship';
--
-- If `shots` or `bombs` is no longer 0, STOP and re-read this file: craters get deleted
-- and bombs get un-fired below, which is right for a game nobody has played yet and
-- worth a second look for one they have.
-- ────────────────────────────────────────────────────────────────────────────

begin;

-- The one event, by slug. Everything below hangs off this.
create temporary table _target on commit drop as
select id from vs_events where slug = 'battleship' and kind = 'battleship';

-- Abort the whole transaction unless that matched exactly one event.
do $$
declare n int;
begin
	select count(*) into n from _target;
	if n <> 1 then
		raise exception 'expected exactly 1 event with slug "battleship", found %', n;
	end if;
end $$;

-- ── 1. Pin the board, reopen placement ──────────────────────────────────────
-- placement_ends_at MUST be in the future. `maybeAdvancePhase` runs on every page read:
-- a placement deadline already in the past would re-open the battle on the very next
-- load AND auto-place both fleets at random. 24 hours; change the interval to suit.
update vs_events e
set structure = e.structure || jsonb_build_object(
		'battleship',
		(e.structure -> 'battleship') || jsonb_build_object(
			'size', 25,
			'phase', 'placement',
			'placement_ends_at',
			to_char((now() at time zone 'utc') + interval '24 hours', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
		)
	)
from _target t
where e.id = t.id;

-- ── 2. Clear both fleets ────────────────────────────────────────────────────
-- The positions are compromised, and the ship COUNT is wrong for the new board (14 ships
-- at 17x17, 31 at 25x25), so a stored fleet could not have been reused either way.
update vs_battleship_teams bt
set fleet = '[]'::jsonb, placed_at = null
from _target t
where bt.event_id = t.id;

-- ── 3. Craters ──────────────────────────────────────────────────────────────
-- Old coordinates mean nothing against re-placed ships. Expected: 0 rows.
delete from vs_battleship_shots s using _target t where s.event_id = t.id;

-- ── 4. Bombs stay banked ────────────────────────────────────────────────────
-- A bomb was earned by a real drop, so it is not thrown away — just un-fired, since the
-- shot it made has been deleted. Expected: 0 rows.
update vs_battleship_arsenal a
set spent_at = null, bomb_id = null
from _target t
where a.event_id = t.id and a.spent_at is not null;

commit;

-- ── Verify ──────────────────────────────────────────────────────────────────
-- Expect: phase=placement, pinned_size=25, placement_ends_at ~24h out, sides=2,
-- sides_with_ships=0, shots=0, signed_up=85. The draft is untouched.
select e.slug,
       e.structure -> 'battleship' ->> 'phase'             as phase,
       e.structure -> 'battleship' ->> 'size'              as pinned_size,
       e.structure -> 'battleship' ->> 'placement_ends_at' as placement_ends_at,
       (select count(*) from vs_battleship_teams   bt where bt.event_id = e.id) as sides,
       (select count(*) from vs_battleship_teams   bt where bt.event_id = e.id
                                                        and jsonb_array_length(bt.fleet) > 0) as sides_with_ships,
       (select count(*) from vs_battleship_shots   s  where s.event_id  = e.id) as shots,
       (select count(*) from vs_battleship_arsenal a  where a.event_id  = e.id) as bombs,
       (select count(*) from vs_event_signups      g  where g.event_id  = e.id) as signed_up
from vs_events e
where e.slug = 'battleship' and e.kind = 'battleship';
