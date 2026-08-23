-- Pay out VP for a finished Battleship event: every bomb EARNED pays its side's member,
-- once per drop, straight into the Discord bot's `players.points` (VP).
--
--   tier 1  Cannonball  1x1   15 VP
--   tier 2  Bombard     2x2   45 VP
--   tier 3  Broadside   3x3  100 VP
--
-- ── ONCE PER DROP ────────────────────────────────────────────────────────────
--
-- Mid-event the arming rate was doubled (battleship-double-bombs.sql): every drop mints a
-- TWIN bomb whose drop_key is the original's with `:x2` appended. The doubling was a pace
-- lever for the board, not a doubling of the reward, so the twins are excluded here and a
-- doubled drop pays exactly once. Belt and braces, the count is also DISTINCT on the base
-- drop key, so even a twin row that somehow lost its suffix cannot pay twice.
--
-- ── WHAT COUNTS ──────────────────────────────────────────────────────────────
--
--   * FIRED bombs count. The reward is for earning the drop; spending it was the game.
--   * MANUAL CLAIMS count. A screenshot claim that an admin approved minted a real bomb
--     for a real drop — it is a drop that happened to be tracked by hand.
--   * ADMIN GRANTS count (source = 'admin'). They are make-goods for drops the tracker
--     missed, so they stand in for a real drop. To exclude them instead, uncomment the
--     marked line in the _drops query below before running.
--   * Bombs with no `earned_by` (the member was deleted) pay nobody; the count of such
--     rows is recorded in the marker so they are not silently lost.
--
-- ── WHO GETS PAID, AND HOW ───────────────────────────────────────────────────
--
-- VP is `players.points` in the bot's table. A member is matched the same way the site
-- and bot do everywhere else: by discord_id first, then by RSN case-insensitively with
-- `_` and space treated as equal. A member with NO players row cannot hold VP — they are
-- listed under `unmatched` in the marker (and by the verify query) so they can be paid
-- by hand once a row exists.
--
-- ── RUN-ONCE GUARD ───────────────────────────────────────────────────────────
--
-- The whole payout — rates, per-member amounts, unmatched members, orphan count — is
-- written to `structure.battleship.vp_payout` on the event row IN THE SAME TRANSACTION
-- as the points update. The script aborts if that marker already exists, so running it
-- twice cannot double-pay, and the marker doubles as the audit record of what was paid.
--
-- ── PREFLIGHT: run this first, on its own. It changes nothing. ───────────────
--
--   select e.slug, e.status,
--          e.structure -> 'battleship' ->> 'phase'      as phase,
--          e.structure -> 'battleship' -> 'vp_payout'   as already_paid,   -- must be null
--          count(a.*)                                    as bomb_rows,
--          count(a.*) filter (where a.drop_key like '%:x2')       as x2_twins,
--          count(a.*) filter (where coalesce(a.source,'')='admin') as admin_grants,
--          count(a.*) filter (where a.earned_by is null)           as orphaned
--   from vs_events e
--   left join vs_battleship_arsenal a on a.event_id = e.id
--   where e.slug = 'battleship' and e.kind = 'battleship'
--   group by e.id;
--
--   -- The exact per-member amounts this script would pay:
--   select u.rsn, count(*) as drops,
--          sum(case a.tier when 1 then 15 when 2 then 45 when 3 then 100 end) as vp
--   from (
--     select distinct on (regexp_replace(a.drop_key, ':x2$', ''))
--            a.tier, a.earned_by
--     from vs_battleship_arsenal a
--     join vs_events e on e.id = a.event_id
--     where e.slug = 'battleship' and e.kind = 'battleship'
--       and a.drop_key not like '%:x2'
--     order by regexp_replace(a.drop_key, ':x2$', ''), a.earned_at
--   ) a
--   join vs_users u on u.id = a.earned_by
--   group by u.rsn order by vp desc;
--
-- ────────────────────────────────────────────────────────────────────────────

begin;

-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║  SET THIS: the event to pay out.                                         ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
create temporary table _target on commit drop as
select id from vs_events where slug = 'battleship' and kind = 'battleship';

create temporary table _rates (tier int primary key, vp int not null) on commit drop;
insert into _rates values (1, 15), (2, 45), (3, 100);

-- Abort unless exactly one event matched and it has never been paid out.
do $$
declare n int; paid jsonb;
begin
	select count(*) into n from _target;
	if n <> 1 then
		raise exception 'expected _target to match exactly 1 battleship event, found %', n;
	end if;
	select e.structure -> 'battleship' -> 'vp_payout' into paid
	from vs_events e where e.id in (select id from _target);
	if paid is not null then
		raise exception 'this event already has a vp_payout marker (paid at %) — refusing to pay twice',
			paid ->> 'at';
	end if;
end $$;

-- One row per DROP: the :x2 doubling twins are excluded, and the DISTINCT ON the base
-- key keeps the earliest row per drop even if a twin ever lost its suffix.
create temporary table _drops on commit drop as
select distinct on (regexp_replace(a.drop_key, ':x2$', ''))
       a.tier, a.earned_by
from vs_battleship_arsenal a
where a.event_id in (select id from _target)
  and a.drop_key not like '%:x2'
--  and coalesce(a.source, '') <> 'admin'   -- uncomment to EXCLUDE admin make-goods
order by regexp_replace(a.drop_key, ':x2$', ''), a.earned_at;

-- A tier outside the rate card would silently pay 0 — refuse instead.
do $$
declare bad int;
begin
	select tier into bad from _drops where tier not in (select tier from _rates) limit 1;
	if bad is not null then
		raise exception 'bomb tier % has no VP rate — add it to _rates first', bad;
	end if;
end $$;

-- Per-member totals, with the player row resolved the house way: discord_id first,
-- then RSN with `_` = space, case-insensitive. Deterministic on a freak double match.
create temporary table _awards on commit drop as
select d.earned_by as user_id, u.rsn, u.discord_id,
       count(*)::int as drops, sum(r.vp)::int as vp,
       p.player_id
from _drops d
join _rates r using (tier)
join vs_users u on u.id = d.earned_by
left join lateral (
	select pl.id as player_id
	from players pl
	where (u.discord_id is not null and pl.discord_id = u.discord_id)
	   or (u.rsn is not null
	       and lower(replace(pl.rsn, '_', ' ')) = lower(replace(u.rsn, '_', ' ')))
	order by (pl.discord_id = u.discord_id) desc nulls last, pl.id
	limit 1
) p on true
where d.earned_by is not null
group by d.earned_by, u.rsn, u.discord_id, p.player_id;

-- ── 1. The points ───────────────────────────────────────────────────────────
update players p
set points = coalesce(p.points, 0) + a.vp
from _awards a
where a.player_id = p.id;

-- ── 2. The record ───────────────────────────────────────────────────────────
-- Same transaction as the points, so the marker exists iff the VP landed.
update vs_events e
set structure = jsonb_set(
	coalesce(e.structure, '{}'::jsonb),
	'{battleship,vp_payout}',
	jsonb_build_object(
		'at', now(),
		'rates', (select jsonb_object_agg(tier::text, vp) from _rates),
		'rule', 'once per drop; :x2 twins excluded; fired bombs and admin make-goods count',
		'total_vp', coalesce((select sum(vp) from _awards where player_id is not null), 0),
		'paid', coalesce((select jsonb_agg(jsonb_build_object(
				'rsn', rsn, 'discord_id', discord_id, 'player_id', player_id,
				'drops', drops, 'vp', vp) order by vp desc)
			from _awards where player_id is not null), '[]'::jsonb),
		'unmatched', coalesce((select jsonb_agg(jsonb_build_object(
				'rsn', rsn, 'discord_id', discord_id, 'drops', drops, 'vp', vp))
			from _awards where player_id is null), '[]'::jsonb),
		'orphan_drops', (select count(*) from _drops where earned_by is null)
	),
	true)
where e.id in (select id from _target);

commit;

-- ── VERIFY (run after) ──────────────────────────────────────────────────────
--
-- The full audit record — who was paid what, who could not be matched to a players
-- row (pay those by hand), and how many bombs had no earner left:
--
--   select jsonb_pretty(e.structure -> 'battleship' -> 'vp_payout')
--   from vs_events e where e.slug = 'battleship' and e.kind = 'battleship';
--
-- Spot-check a member's balance against the marker's `vp` for them:
--
--   select rsn, points from players
--   where lower(replace(rsn, '_', ' ')) = lower(replace('<their rsn>', '_', ' '));