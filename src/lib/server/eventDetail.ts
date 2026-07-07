import { error } from '@sveltejs/kit';
import { db, fetchAllFiltered } from './db';
import type { SessionUser } from './auth';
import { isAdmin } from './auth';
import { CLAN_LABEL, CLAN_OPTIONS } from '$lib/clans';
import { ACCOUNT_TYPES } from '$lib/accountTypes';
import { renderMarkdown } from '$lib/markdown';
import { isTaskEvent } from '$lib/events/simple';
import { BINGO_EVENT_SLUG } from '$lib/bingo/config';
import { buildBingoDetail, type BingoDetail } from './bingoPage';
import { DUO_WOLF_EVENT_SLUG } from './duoWolfTiles';
import { loadDuoStandings, type DuoStandings } from './duoStandings';

// Builds the /events/[slug] detail payload for /api/events/[slug]. The page has NO
// server load — its universal load fires this fetch without awaiting, so navigation
// lands instantly on a skeleton event. Because the page renders before this
// resolves, the outcomes the server load used to enforce up front (404, task-event
// redirect, live-team board redirect) come back as a discriminated result the
// client acts on when it arrives.

interface SignupRow {
	id: string;
	user_id: string;
	team_id: string | null;
	joined_at: string;
	vs_users: {
		id: string;
		rsn: string | null;
		discord_username: string;
		clan_allegiance: string | null;
		account_type: string | null;
	};
}

interface InviteRow {
	id: string;
	from_user_id: string;
	to_user_id: string;
	created_at: string;
}

// TODO: remove demo augmentation once we no longer need to preview the
// crowded-event UI. Triggered only when the URL has ?demo=1.
function buildDemoData() {
	const prefixes = ['HCIM', 'GIM', 'UIM', 'Iron', 'Pure', 'Skill', 'PVM', 'Bot'];
	const clans = CLAN_OPTIONS.map((c) => c.value);

	const accountValues = ACCOUNT_TYPES.map((a) => a.value);

	const soloPool = Array.from({ length: 50 }, (_, idx) => {
		const i = idx + 1;
		const clan = clans[i % clans.length];
		return {
			user_id: `fake-solo-${i}`,
			rsn: `${prefixes[i % prefixes.length]} ${String(i).padStart(3, '0')}`,
			discord_username: `seed_user_${i}`,
			clan_allegiance: clan as string | null,
			clan_label: CLAN_LABEL[clan] as string | null,
			account_type: accountValues[i % accountValues.length] as string | null
		};
	});

	const teams = Array.from({ length: 50 }, (_, idx) => {
		const t = idx + 1;
		const a = t * 2 - 1;
		const b = t * 2;
		const aClan = clans[a % clans.length];
		const bClan = clans[b % clans.length];
		return {
			team_id: `fake-team-${t}`,
			name: t % 3 === 0 ? null : `Team ${String(t).padStart(2, '0')}`,
			members: [
				{
					rsn: `${prefixes[a % prefixes.length]} ${String(a + 100).padStart(3, '0')}`,
					discord_username: `seed_pair_${a}`,
					clan_allegiance: aClan as string | null,
					clan_label: CLAN_LABEL[aClan] as string | null,
					account_type: accountValues[a % accountValues.length] as string | null
				},
				{
					rsn: `${prefixes[b % prefixes.length]} ${String(b + 100).padStart(3, '0')}`,
					discord_username: `seed_pair_${b}`,
					clan_allegiance: bClan as string | null,
					clan_label: CLAN_LABEL[bClan] as string | null,
					account_type: accountValues[b % accountValues.length] as string | null
				}
			]
		};
	});

	const clanCounts: Record<string, number> = {};
	for (const p of soloPool) {
		const k = p.clan_allegiance ?? 'unknown';
		clanCounts[k] = (clanCounts[k] ?? 0) + 1;
	}
	for (const team of teams) {
		for (const m of team.members) {
			const k = m.clan_allegiance ?? 'unknown';
			clanCounts[k] = (clanCounts[k] ?? 0) + 1;
		}
	}

	return {
		soloPool,
		teams,
		clanCounts,
		signupAdd: 150,
		teamAdd: 50,
		soloAdd: 50
	};
}

export type BingoOk = Extract<BingoDetail, { kind: 'ok' }>;

export type EventDetailResult =
	| { kind: 'not_found' }
	| { kind: 'redirect'; to: string }
	| (Omit<BingoOk, 'kind'> & { kind: 'bingo' })
	| (Awaited<ReturnType<typeof buildOk>> & { kind: 'ok' });

export async function buildEventDetail(
	user: SessionUser,
	slug: string,
	opts: { teamsView: boolean; demo: boolean }
): Promise<EventDetailResult> {
	const supabase = db();

	const { data: event, error: eventErr } = await supabase
		.from('vs_events')
		.select(
			'id, slug, name, kind, description, status, signup_opens_at, signup_closes_at, starts_at, team_size, owner_user_id'
		)
		.eq('slug', slug)
		.maybeSingle();

	if (eventErr) throw error(500, eventErr.message);
	if (!event) return { kind: 'not_found' };

	// Bingo events are served on this same URL — one page per event slug, whatever
	// its kind. The bingo builder owns its redaction/archive logic.
	if (event.kind === 'bingo' || event.slug === BINGO_EVENT_SLUG) {
		const bingo = await buildBingoDetail(user, slug);
		if (bingo.kind !== 'ok') return { kind: 'not_found' };
		return { ...bingo, kind: 'bingo' as const };
	}

	// This page is the bespoke DuoWolf detail; task events (open/sequential) live on
	// the generic /event/[slug] page. (Custom/legacy events stay here.)
	if (isTaskEvent(event.kind)) return { kind: 'redirect', to: `/event/${slug}` };
	if ((event.status === 'preview' || event.status === 'draft') && !isAdmin(user)) {
		return { kind: 'not_found' };
	}

	// Once the DuoWolf climb is LIVE (event open + its start time has arrived), the board IS
	// this page. TEAMED players go straight to the board; SOLO (un-teamed) players stay here
	// so they can choose to "Play solo" (join the climb as a team of one). Anyone can reach
	// the standings via ?view=teams. Pre-live it's the normal signup view.
	const isDuo = event.slug === DUO_WOLF_EVENT_SLUG;
	const startsAt = event.starts_at ? new Date(event.starts_at).getTime() : null;
	const eventLive = isDuo && event.status === 'open' && startsAt != null && Date.now() >= startsAt;
	const teamsView = eventLive && opts.teamsView;
	if (eventLive && !teamsView) {
		const { data: su } = await supabase
			.from('vs_event_signups')
			.select('team_id')
			.eq('event_id', event.id)
			.eq('user_id', user.id)
			.maybeSingle();
		if (su?.team_id) return { kind: 'redirect', to: `/events/${slug}/board` };
	}

	const ok = await buildOk(user, event, { isDuo, eventLive, teamsView, demo: opts.demo });
	return { kind: 'ok', ...ok };
}

async function buildOk(
	user: SessionUser,
	event: {
		id: string;
		slug: string;
		name: string;
		kind: string;
		description: string | null;
		status: string;
		signup_opens_at: string | null;
		signup_closes_at: string | null;
		starts_at: string | null;
		team_size: number | null;
		owner_user_id: string | null;
	},
	flags: { isDuo: boolean; eventLive: boolean; teamsView: boolean; demo: boolean }
) {
	const supabase = db();
	const { isDuo, eventLive, teamsView } = flags;

	// One parallel round for everything that only needs the event row: signups + teams
	// (paginated past the 1000-row cap), the host lookup, and the caller's pending
	// invites.
	const [{ data: signupsRaw }, { data: teamsRaw }, hostRes, invitesRes] = await Promise.all([
		fetchAllFiltered((f, t) =>
			supabase
				.from('vs_event_signups')
				.select(
					'id, user_id, team_id, joined_at, vs_users(id, rsn, discord_username, clan_allegiance, account_type)'
				)
				.eq('event_id', event.id)
				.order('joined_at', { ascending: true })
				.range(f, t)
		),
		fetchAllFiltered((f, t) => supabase.from('vs_teams').select('id, name').eq('event_id', event.id).range(f, t)),
		// Who hosts this event (the admin who created it) — shown so members know who to contact.
		event.owner_user_id
			? supabase
					.from('vs_users')
					.select('rsn, discord_username')
					.eq('id', event.owner_user_id)
					.maybeSingle()
			: Promise.resolve({ data: null }),
		supabase
			.from('vs_team_invites')
			.select('id, from_user_id, to_user_id, created_at')
			.eq('event_id', event.id)
			.eq('status', 'pending')
			.or(`from_user_id.eq.${user.id},to_user_id.eq.${user.id}`)
	]);

	const host: { rsn: string | null; discord_username: string | null } | null =
		hostRes.data ?? null;

	const signups = (signupsRaw ?? []) as unknown as SignupRow[];
	const teamNameById = new Map<string, string | null>(
		((teamsRaw ?? []) as { id: string; name: string | null }[]).map((t) => [t.id, t.name])
	);

	const mySignup = signups.find((s) => s.user_id === user.id) ?? null;

	const teamMap = new Map<string, SignupRow[]>();
	for (const s of signups) {
		if (!s.team_id) continue;
		const arr = teamMap.get(s.team_id) ?? [];
		arr.push(s);
		teamMap.set(s.team_id, arr);
	}

	const myTeam = mySignup?.team_id ? teamMap.get(mySignup.team_id) ?? [] : [];

	const soloPool = signups
		.filter((s) => !s.team_id && s.user_id !== user.id)
		.map((s) => ({
			user_id: s.user_id,
			rsn: s.vs_users.rsn,
			discord_username: s.vs_users.discord_username,
			clan_allegiance: s.vs_users.clan_allegiance,
			clan_label: s.vs_users.clan_allegiance
				? CLAN_LABEL[s.vs_users.clan_allegiance as keyof typeof CLAN_LABEL]
				: null,
			account_type: s.vs_users.account_type
		}));

	// Invites were fetched unconditionally above (they only need event + user); the
	// original gate still applies when SHAPING them — only un-teamed signed-up users
	// see pending invites.
	let pendingInvites: { incoming: InviteRow[]; outgoing: InviteRow[] } = {
		incoming: [],
		outgoing: []
	};

	if (mySignup && !mySignup.team_id) {
		const invites = (invitesRes.data ?? []) as InviteRow[];
		pendingInvites = {
			incoming: invites.filter((i) => i.to_user_id === user.id),
			outgoing: invites.filter((i) => i.from_user_id === user.id)
		};
	}

	const userById = new Map(signups.map((s) => [s.user_id, s.vs_users]));

	const incomingInvites = pendingInvites.incoming.map((i) => ({
		id: i.id,
		from: userById.get(i.from_user_id) ?? null
	}));
	const outgoingInvites = pendingInvites.outgoing.map((i) => ({
		id: i.id,
		to: userById.get(i.to_user_id) ?? null
	}));

	const teams = Array.from(teamMap.entries()).map(([teamId, members]) => ({
		team_id: teamId,
		name: teamNameById.get(teamId) ?? null,
		members: members.map((m) => ({
			rsn: m.vs_users.rsn,
			discord_username: m.vs_users.discord_username,
			clan_allegiance: m.vs_users.clan_allegiance,
			clan_label: m.vs_users.clan_allegiance
				? CLAN_LABEL[m.vs_users.clan_allegiance as keyof typeof CLAN_LABEL]
				: null,
			account_type: m.vs_users.account_type
		}))
	}));

	const clanCounts: Record<string, number> = {};
	for (const s of signups) {
		const clan = s.vs_users.clan_allegiance ?? 'unknown';
		clanCounts[clan] = (clanCounts[clan] ?? 0) + 1;
	}

	let totalSignups = signups.length;
	let teamCount = teamMap.size;
	let soloCount = signups.filter((s) => !s.team_id).length;
	let finalSoloPool = soloPool;
	let finalTeams = teams;

	if (flags.demo) {
		const demo = buildDemoData();
		finalSoloPool = [...soloPool, ...demo.soloPool];
		finalTeams = [...teams, ...demo.teams];
		totalSignups += demo.signupAdd;
		teamCount += demo.teamAdd;
		soloCount += demo.soloAdd;
		for (const [clan, n] of Object.entries(demo.clanCounts)) {
			clanCounts[clan] = (clanCounts[clan] ?? 0) + n;
		}
	}

	const clanBreakdown = Object.entries(clanCounts).map(([clan, count]) => ({
		clan,
		label: clan in CLAN_LABEL ? CLAN_LABEL[clan as keyof typeof CLAN_LABEL] : clan,
		count
	}));

	// Roster for the admin manage tools (pair / remove). Real signups only (never the
	// ?demo augmentation) since those are the rows the actions can touch.
	const admin = isAdmin(user);
	const adminSignups = admin
		? signups.map((s) => ({
				user_id: s.user_id,
				name: s.vs_users.rsn || s.vs_users.discord_username,
				team_id: s.team_id
			}))
		: [];

	// Standings (all teams + how far they've climbed, with clan tabs). Served whenever
	// the climb is live. Awaited here (this whole payload already streams to the page),
	// with the roster/teams handed over so it doesn't re-issue those reads.
	let standings: DuoStandings | null = null;
	if (eventLive) {
		standings = await loadDuoStandings(
			event.id,
			mySignup?.team_id ?? null,
			{ topN: 9999, perClanCap: 9999, markersTopN: 0 },
			{
				teams: ((teamsRaw ?? []) as { id: string; name: string | null }[]),
				signups: signups.map((s) => ({ team_id: s.team_id, vs_users: s.vs_users }))
			}
		).catch(() => null);
	}

	return {
		isAdmin: admin,
		isDuo,
		eventLive,
		teamsView,
		standings,
		adminSignups,
		event: { ...event, description_html: renderMarkdown(event.description) },
		host,
		mySignup: mySignup
			? {
					id: mySignup.id,
					team_id: mySignup.team_id,
					team_name: mySignup.team_id ? teamNameById.get(mySignup.team_id) ?? null : null
				}
			: null,
		myTeam: myTeam.map((m) => ({
			user_id: m.user_id,
			rsn: m.vs_users.rsn,
			discord_username: m.vs_users.discord_username,
			account_type: m.vs_users.account_type,
			isMe: m.user_id === user.id
		})),
		soloPool: finalSoloPool,
		incomingInvites,
		outgoingInvites,
		teams: finalTeams,
		stats: {
			totalSignups,
			teamCount,
			soloCount,
			clanBreakdown
		}
	};
}
