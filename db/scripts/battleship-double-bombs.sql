-- Two bombs per drop instead of one, for a live Battleship event.
--
-- The pace lever that doesn't touch the rules everyone was told: floors stay where they
-- are, bomb sizes stay where they are, every drop just arms twice. Roughly halves the
-- time to finish, and it is the easiest one to announce because nothing gets harder and
-- nobody loses anything.
--
--
-- ── TWO INDEPENDENT PARTS. RUN EITHER, OR BOTH. ─────────────────────────────
--
--   PART 1 catches up the drops already banked — a one-off retroactive twin for every
--   bomb earned before now. Pure SQL, runs once, done. NOT a rate change: on its own the
--   event goes back to its old pace tomorrow.
--
--   PART 2 makes FUTURE drops arm twice, and is the part that actually changes the pace.
--   It cannot be a one-off statement: minting happens in `earnBomb`, which writes exactly
--   one row per drop and leans on `unique (event_id, drop_key)` to stay idempotent. So
--   Part 2 is a TRIGGER — the database mints the twin itself, at insert time, no deploy.
--
-- Each part is its own transaction and neither depends on the other. **Part 2 alone is
-- the "new rule from here on" option**: nobody's existing bombs change, and every drop
-- from the moment it commits arms two.
--
-- One wrinkle worth knowing if you run Part 2 alone: the Dink consumer runs on a timer, so
-- a drop that LANDED before you ran this but gets processed after will still arm two. That
-- is the trigger firing on the insert, not on the kill — it is a few minutes of overlap,
-- not a bug, and it explains any "why did they get two for an old drop".
--
--
-- ── WHAT A TRIGGER COSTS YOU ────────────────────────────────────────────────
--
-- This is deliberate, reversible machinery, but it is machinery that lives in the
-- database and not in the repo's code path, so:
--
--   * Nothing in `src/` mentions it. Someone reading `earnBomb` will count one bomb per
--     drop and be wrong. That is the real price — it is why this file exists and why
--     docs/BATTLESHIP.md points at it.
--   * `removeBomb` deletes ONE arsenal row. Pulling a bad drop now means removing the
--     twin too, or the side keeps half of a bomb it should not have. The twin is easy to
--     find: same `drop_key` with `:x2` on the end.
--   * Removing a twin tries to mark `vs_dink_drops.outcome = 'reverted'` for drop_key
--     `...:x2`, which matches nothing. Harmless, but it means removing the twin does NOT
--     close the source — remove the ORIGINAL for that.
--
-- TAKE IT BACK OUT when the event ends (this leaves banked twins alone, which is right —
-- they were legitimately earned while the rule was in force):
--
--   drop trigger if exists vs_battleship_double_bomb_t on vs_battleship_arsenal;
--   drop function if exists vs_battleship_double_bomb();
--
--
-- ── PREFLIGHT: run on its own first. Changes nothing. ───────────────────────
--
--   select count(*) filter (where a.spent_at is null) as banked,
--          count(*) filter (where a.spent_at is not null) as fired,
--          count(*) as total_that_would_double
--   from vs_battleship_arsenal a
--   join vs_events e on e.id = a.event_id
--   where e.slug = 'battleship'
--     and coalesce(a.source, '') <> 'admin'
--     and a.drop_key not like '%:x2';
--
-- `total_that_would_double` is exactly how many new bombs Part 1 creates.
-- ────────────────────────────────────────────────────────────────────────────

-- ════════════════════════════════════════════════════════════════════════════
--  PART 1 — the drops already earned.  OPTIONAL. Skip this whole block for
--  "new rule from here on"; Part 2 below does not need it.
-- ════════════════════════════════════════════════════════════════════════════

begin;

-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║  SET THIS: the event.                                                    ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
create temporary table _target on commit drop as
select id from vs_events where slug = 'battleship' and kind = 'battleship';

do $$
declare n int;
begin
	select count(*) into n from _target;
	if n <> 1 then
		raise exception 'expected _target to match exactly 1 battleship event, found %', n;
	end if;
end $$;

-- ── PART 1: the drops already earned ────────────────────────────────────────
--
-- One twin per drop, INCLUDING drops whose first bomb has already been fired — the rule
-- is "every drop arms two", and someone who spent theirs early should not be punished for
-- it. Their twin arrives unspent, which is the whole point.
--
-- ADMIN GRANTS are skipped: a make-good is not a drop, and doubling one silently doubles
-- whatever an admin decided to hand out.
--
-- Idempotent — `:x2` keys are excluded from the source set and collide on
-- `unique (event_id, drop_key)` anyway, so running this twice adds nothing.
insert into vs_battleship_arsenal
	(event_id, side, earned_by, tier, value, item_name, source, drop_key, earned_at)
select a.event_id, a.side, a.earned_by, a.tier, a.value, a.item_name, a.source,
       a.drop_key || ':x2', a.earned_at
from vs_battleship_arsenal a
where a.event_id in (select id from _target)
  and coalesce(a.source, '') <> 'admin'
  and a.drop_key not like '%:x2'
on conflict (event_id, drop_key) do nothing;

commit;

-- ════════════════════════════════════════════════════════════════════════════
--  PART 2 — every drop from here on.  This is the pace change. Self-contained:
--  it scopes itself by slug and needs nothing from Part 1.
-- ════════════════════════════════════════════════════════════════════════════

begin;

-- The slug is written into the trigger body below, so a typo there would arm a trigger
-- that silently never fires. Fail loudly instead.
do $$
declare n int;
begin
	select count(*) into n from vs_events
	where slug = 'battleship' and kind = 'battleship';
	if n <> 1 then
		raise exception
			'expected exactly 1 battleship event with that slug, found % — the trigger below would never fire', n;
	end if;
end $$;

-- ── PART 2: every drop from here on ─────────────────────────────────────────
--
-- Fires AFTER each arsenal insert and writes the twin. The twin's own insert fires the
-- trigger again, and the `:x2` guard is what stops that recursing — do not remove it.
--
-- Scoped to the ONE event by slug, so a test game, a demo, or the next event is
-- unaffected and this cannot quietly outlive its purpose.
create or replace function vs_battleship_double_bomb() returns trigger
language plpgsql as $$
begin
	-- The twin itself, and admin grants, mint nothing further.
	if new.drop_key like '%:x2' or coalesce(new.source, '') = 'admin' then
		return new;
	end if;
	if not exists (
		select 1 from vs_events e
		where e.id = new.event_id and e.slug = 'battleship' and e.kind = 'battleship'
	) then
		return new;
	end if;

	insert into vs_battleship_arsenal
		(event_id, side, earned_by, tier, value, item_name, source, drop_key, earned_at)
	values
		(new.event_id, new.side, new.earned_by, new.tier, new.value, new.item_name,
		 new.source, new.drop_key || ':x2', new.earned_at)
	on conflict (event_id, drop_key) do nothing;

	return new;
end $$;

comment on function vs_battleship_double_bomb() is
	'Mid-event pace lever: arms a second bomb for every drop banked against the live '
	'Battleship event. Not visible from src/ — see db/scripts/battleship-double-bombs.sql. '
	'Drop the trigger and this function when the event ends.';

drop trigger if exists vs_battleship_double_bomb_t on vs_battleship_arsenal;
create trigger vs_battleship_double_bomb_t
	after insert on vs_battleship_arsenal
	for each row execute function vs_battleship_double_bomb();

commit;

-- ── VERIFY (run after) ──────────────────────────────────────────────────────
--
--   -- Every non-admin drop should now have exactly one twin.
--   select count(*) filter (where a.drop_key like '%:x2') as twins,
--          count(*) filter (where a.drop_key not like '%:x2'
--                             and coalesce(a.source,'') <> 'admin') as originals
--   from vs_battleship_arsenal a
--   join vs_events e on e.id = a.event_id
--   where e.slug = 'battleship';
--
-- Those two numbers must match. And the trigger is armed:
--
--   select tgname, tgenabled from pg_trigger where tgname = 'vs_battleship_double_bomb_t';
