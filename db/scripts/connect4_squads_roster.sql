-- Connect Four — assigning the clan's internal teams (squads) for the
-- Volition vs IronClad board. Hand-applied; needs db/scripts/connect4_squads.sql first.
--
-- WHY THIS MATCHES THE WAY IT DOES. The rosters arrive as three flat lines of names, and
-- an OSRS RSN may contain spaces — so "Bag Callum RW6" could be one player or two, and
-- nothing in the text says which. Rather than guess a split, this asks the DATABASE where
-- the boundaries are: every RSN already signed up to this event is looked for as a
-- whitespace-delimited run inside each team's line. Real names come from vs_users, so the
-- ambiguity never has to be resolved by hand.
--
-- Spaces, underscores and hyphens are normalised on BOTH sides, so "Decent-ish" in the
-- paste matches "Decent-ish", "Decent ish" or "Decent_ish" in the database.
--
-- Run the three SELECTs first. Only step 4 writes.

-- ── step 1 — what will be assigned ────────────────────────────────────────────
with ev as (
	select id from vs_events where slug = 'volition-vs-ironclad'
),
teams (squad, blob) as (
	values
		('red', 'lReky KenneDIY Dergynstoned Bag Callum RW6 eXiLed GIM imor tas im gone soon SoakedPage Virtsa Dr Roni Table Salt ImBTher spence iron Wee arra Forcedtogim mucus mayo winnie IM Raibreads Rinbos Reetznutz Aces Kevsto SigmaHarambe GoochMaxxing fylie Matteeeezy BBlastoise Liquidmorph3 zzalf Fishermonn Gim SLeppy ThomasBTWs IM Roubam Rimuru BTW Retaliateee Sly Pigeon Trickky Zilly Zappo IM Snead'),
		('blue', '6Dixoncider9 Diode Ex BigDirtyHugo El Prawn Mayo Blaster Dickanator GIM drivss JayRobStacks CAB Archie KingRazenoid TheForgeGod hotwheels63 Stahlinski Mx tty 3BTBIron GIM puddinz D Dot Tyluh Ryan 219 BTW GIM Jive Skippyhelmet micro pp cuddy phlam CAB Jimmy WokWonger69 Peen Pixelz Owo nya Ryhmis Its me Ted IM Kikita Matterhornjr Nice Cahk JoshLeft isquatter Dragoon Ry La Kubera Sir Striker Peen Chud Rumsy'),
		('yellow', 'Stoonly UitGehold Decent-ish Akoudeng Ja c kk Mini Logie yynniv TexasOhio LDonk diepekeel Not PP H0rnyhunter7 Bwana Phoque leviathan232 M at TrulyObese Tootightiron CafeLillia Jarl BTW Sir Iron 4 U Wispr T iddies Dave I Guess large marty Do L0 Proxey Ithilmar Dairis lops Weiny Water Dadsty Babnelo Egirlhonkers Ap eks Ebdy Midoh Call isto HUZE Maccaroni Gastr0')
),
hay as (
	select squad, ' ' || lower(regexp_replace(blob, '[\s_-]+', ' ', 'g')) || ' ' as line
	from teams
),
players as (
	select
		u.id as user_id,
		u.rsn,
		' ' || lower(regexp_replace(btrim(u.rsn), '[\s_-]+', ' ', 'g')) || ' ' as needle
	from vs_event_signups s
	join vs_users u on u.id = s.user_id
	where s.event_id = (select id from ev)
	  and u.rsn is not null
	  and btrim(u.rsn) <> ''
),
hits as (
	select p.user_id, p.rsn, h.squad
	from players p
	join hay h on position(p.needle in h.line) > 0
)
select squad, count(*) as players, string_agg(rsn, ', ' order by lower(rsn)) as matched
from hits
group by squad
order by squad;

-- ── step 2 — names that matched TWO teams (fix these before writing) ──────────
-- A short RSN can sit inside another player's name run. Nothing is written for anyone
-- who appears here; decide by hand and insert them individually.
with ev as (
	select id from vs_events where slug = 'volition-vs-ironclad'
),
teams (squad, blob) as (
	values
		('red', 'lReky KenneDIY Dergynstoned Bag Callum RW6 eXiLed GIM imor tas im gone soon SoakedPage Virtsa Dr Roni Table Salt ImBTher spence iron Wee arra Forcedtogim mucus mayo winnie IM Raibreads Rinbos Reetznutz Aces Kevsto SigmaHarambe GoochMaxxing fylie Matteeeezy BBlastoise Liquidmorph3 zzalf Fishermonn Gim SLeppy ThomasBTWs IM Roubam Rimuru BTW Retaliateee Sly Pigeon Trickky Zilly Zappo IM Snead'),
		('blue', '6Dixoncider9 Diode Ex BigDirtyHugo El Prawn Mayo Blaster Dickanator GIM drivss JayRobStacks CAB Archie KingRazenoid TheForgeGod hotwheels63 Stahlinski Mx tty 3BTBIron GIM puddinz D Dot Tyluh Ryan 219 BTW GIM Jive Skippyhelmet micro pp cuddy phlam CAB Jimmy WokWonger69 Peen Pixelz Owo nya Ryhmis Its me Ted IM Kikita Matterhornjr Nice Cahk JoshLeft isquatter Dragoon Ry La Kubera Sir Striker Peen Chud Rumsy'),
		('yellow', 'Stoonly UitGehold Decent-ish Akoudeng Ja c kk Mini Logie yynniv TexasOhio LDonk diepekeel Not PP H0rnyhunter7 Bwana Phoque leviathan232 M at TrulyObese Tootightiron CafeLillia Jarl BTW Sir Iron 4 U Wispr T iddies Dave I Guess large marty Do L0 Proxey Ithilmar Dairis lops Weiny Water Dadsty Babnelo Egirlhonkers Ap eks Ebdy Midoh Call isto HUZE Maccaroni Gastr0')
),
hay as (
	select squad, ' ' || lower(regexp_replace(blob, '[\s_-]+', ' ', 'g')) || ' ' as line
	from teams
),
players as (
	select u.id as user_id, u.rsn,
		' ' || lower(regexp_replace(btrim(u.rsn), '[\s_-]+', ' ', 'g')) || ' ' as needle
	from vs_event_signups s
	join vs_users u on u.id = s.user_id
	where s.event_id = (select id from ev) and u.rsn is not null and btrim(u.rsn) <> ''
),
hits as (
	select p.user_id, p.rsn, h.squad
	from players p join hay h on position(p.needle in h.line) > 0
)
select rsn, string_agg(squad, ' + ' order by squad) as claimed_by
from hits
group by user_id, rsn
having count(distinct squad) > 1
order by lower(rsn);

-- ── step 3 — WRITE. Re-running is an upsert, never a second membership ────────
with ev as (
	select id from vs_events where slug = 'volition-vs-ironclad'
),
teams (squad, blob) as (
	values
		('red', 'lReky KenneDIY Dergynstoned Bag Callum RW6 eXiLed GIM imor tas im gone soon SoakedPage Virtsa Dr Roni Table Salt ImBTher spence iron Wee arra Forcedtogim mucus mayo winnie IM Raibreads Rinbos Reetznutz Aces Kevsto SigmaHarambe GoochMaxxing fylie Matteeeezy BBlastoise Liquidmorph3 zzalf Fishermonn Gim SLeppy ThomasBTWs IM Roubam Rimuru BTW Retaliateee Sly Pigeon Trickky Zilly Zappo IM Snead'),
		('blue', '6Dixoncider9 Diode Ex BigDirtyHugo El Prawn Mayo Blaster Dickanator GIM drivss JayRobStacks CAB Archie KingRazenoid TheForgeGod hotwheels63 Stahlinski Mx tty 3BTBIron GIM puddinz D Dot Tyluh Ryan 219 BTW GIM Jive Skippyhelmet micro pp cuddy phlam CAB Jimmy WokWonger69 Peen Pixelz Owo nya Ryhmis Its me Ted IM Kikita Matterhornjr Nice Cahk JoshLeft isquatter Dragoon Ry La Kubera Sir Striker Peen Chud Rumsy'),
		('yellow', 'Stoonly UitGehold Decent-ish Akoudeng Ja c kk Mini Logie yynniv TexasOhio LDonk diepekeel Not PP H0rnyhunter7 Bwana Phoque leviathan232 M at TrulyObese Tootightiron CafeLillia Jarl BTW Sir Iron 4 U Wispr T iddies Dave I Guess large marty Do L0 Proxey Ithilmar Dairis lops Weiny Water Dadsty Babnelo Egirlhonkers Ap eks Ebdy Midoh Call isto HUZE Maccaroni Gastr0')
),
hay as (
	select squad, ' ' || lower(regexp_replace(blob, '[\s_-]+', ' ', 'g')) || ' ' as line
	from teams
),
players as (
	select u.id as user_id, u.rsn,
		' ' || lower(regexp_replace(btrim(u.rsn), '[\s_-]+', ' ', 'g')) || ' ' as needle
	from vs_event_signups s
	join vs_users u on u.id = s.user_id
	where s.event_id = (select id from ev) and u.rsn is not null and btrim(u.rsn) <> ''
),
hits as (
	select p.user_id, p.rsn, h.squad
	from players p join hay h on position(p.needle in h.line) > 0
),
clean as (
	select user_id, min(squad) as squad
	from hits
	group by user_id
	having count(distinct squad) = 1
)
insert into vs_connect4_squads (event_id, user_id, squad)
select (select id from ev), user_id, squad from clean
on conflict (event_id, user_id) do update set squad = excluded.squad;

-- ── step 4 — who on the Volition side is still on no team ─────────────────────
select u.rsn
from vs_event_signups s
join vs_users u on u.id = s.user_id
join vs_teams t on t.id = s.team_id
left join vs_connect4_squads q
	on q.event_id = s.event_id and q.user_id = s.user_id
where s.event_id = (select id from vs_events where slug = 'volition-vs-ironclad')
  and t.name ilike '%volition%'
  and q.user_id is null
order by lower(u.rsn);
