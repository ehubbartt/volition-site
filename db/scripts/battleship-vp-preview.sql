-- READ-ONLY preview for battleship-vp-payout.sql — run this FIRST, on its own.
-- It changes nothing. It prints exactly what the payout script would pay, member by
-- member, using the same rules and the same player matching, so the numbers here ARE
-- the numbers that would land. If a rule is toggled in the payout script (the
-- admin-grants line), toggle the matching line here too, or the preview lies.
--
-- Columns:
--   who      the member's RSN (site account), or the summary rows at the bottom
--   x1/x2/x3 how many 1x1 / 2x2 / 3x3 bombs pay (once per drop — :x2 twins excluded)
--   drops    total paying drops
--   vp       what they receive
--   pays     'players #<id>' when a player row was matched (VP lands there);
--            'NO PLAYER ROW — pay by hand' when nobody matched (the payout script
--            lists these under `unmatched` and pays them nothing)
--
-- The summary rows:
--   ── TOTAL ──        the sum that would actually land in players.points
--   orphaned drops     bombs whose earner was deleted; pay nobody, counted for audit

with target as (
	-- ╔══════════════════════════════════════════════════════════════════════╗
	-- ║  SET THIS to the same event as the payout script.                    ║
	-- ╚══════════════════════════════════════════════════════════════════════╝
	select id from vs_events where slug = 'battleship' and kind = 'battleship'
),
rates (tier, vp) as (values (1, 15), (2, 45), (3, 100)),
-- One row per DROP — identical to the payout script's _drops.
drops as (
	select distinct on (regexp_replace(a.drop_key, ':x2$', ''))
	       a.tier, a.earned_by
	from vs_battleship_arsenal a
	where a.event_id in (select id from target)
	  and a.drop_key not like '%:x2'
--	  and coalesce(a.source, '') <> 'admin'   -- keep in step with the payout script
	order by regexp_replace(a.drop_key, ':x2$', ''), a.earned_at
),
awards as (
	select u.rsn, u.discord_id,
	       count(*) filter (where d.tier = 1)::int as x1,
	       count(*) filter (where d.tier = 2)::int as x2,
	       count(*) filter (where d.tier = 3)::int as x3,
	       count(*)::int as drops,
	       sum(r.vp)::int as vp,
	       count(*) filter (where r.vp is null)::int as unrated,
	       p.player_id
	from drops d
	left join rates r using (tier)
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
	group by u.rsn, u.discord_id, p.player_id
)
select who, x1, x2, x3, drops, vp, pays
from (
	select 0 as ord, coalesce(rsn, '(no rsn)') as who, x1, x2, x3, drops, vp,
	       case
	           when unrated > 0 then '⚠ HAS A TIER WITH NO RATE — fix _rates first'
	           when player_id is not null then 'players #' || player_id
	           else 'NO PLAYER ROW — pay by hand'
	       end as pays
	from awards
	union all
	select 1, '── TOTAL landing in players.points ──',
	       null, null, null, null,
	       coalesce((select sum(vp) from awards where player_id is not null), 0),
	       (select count(*) from awards where player_id is not null) || ' members'
	union all
	select 2, 'unmatched (need a hand-payout)', null, null, null, null,
	       coalesce((select sum(vp) from awards where player_id is null), 0),
	       (select count(*) from awards where player_id is null) || ' members'
	union all
	select 3, 'orphaned drops (earner deleted, pay nobody)', null, null, null,
	       (select count(*)::int from drops where earned_by is null), null, ''
) rows
order by ord, vp desc nulls last, who;