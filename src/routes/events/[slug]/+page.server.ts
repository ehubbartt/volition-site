import { redirect, fail, error } from '@sveltejs/kit';
import { db, fetchAllFiltered } from '$lib/server/db';
import { CLAN_LABEL, CLAN_OPTIONS } from '$lib/clans';
import { ACCOUNT_TYPES } from '$lib/accountTypes';
import { renderMarkdown } from '$lib/markdown';
import { isAdmin } from '$lib/server/auth';
import { BINGO_EVENT_SLUG } from '$lib/bingo/config';
import { isTaskEvent } from '$lib/events/simple';
import { DUO_WOLF_EVENT_SLUG } from '$lib/server/duoWolfTiles';
import { loadDuoStandings, type DuoStandings } from '$lib/server/duoStandings';
import type { Actions, PageServerLoad } from './$types';

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

export const load: PageServerLoad = async ({ params, locals, url }) => {
	if (!locals.user) throw redirect(303, '/');
	if (!locals.user.rsn || !locals.user.clan_allegiance || !locals.user.account_type) {
		throw redirect(303, '/onboarding');
	}
	if (params.slug === BINGO_EVENT_SLUG) throw redirect(303, `/bingo/${params.slug}`);

	const supabase = db();

	const { data: event, error: eventErr } = await supabase
		.from('vs_events')
		.select(
			'id, slug, name, kind, description, status, signup_opens_at, signup_closes_at, starts_at, team_size, owner_user_id'
		)
		.eq('slug', params.slug)
		.maybeSingle();

	if (eventErr) throw error(500, eventErr.message);
	if (!event) throw error(404, 'Event not found');

	// This page is the bespoke DuoWolf detail; task events (open/sequential) live on
	// the generic /event/[slug] page. (Custom/legacy events stay here.)
	if (isTaskEvent(event.kind)) throw redirect(307, `/event/${params.slug}`);
	if ((event.status === 'preview' || event.status === 'draft') && !isAdmin(locals.user)) {
		throw error(404, 'Event not found');
	}

	// Once the DuoWolf climb is LIVE (event open + its start time has arrived), the board IS
	// this page. TEAMED players go straight to the board; SOLO (un-teamed) players stay here
	// so they can choose to "Play solo" (join the climb as a team of one). Anyone can reach
	// the standings via ?view=teams. Pre-live it's the normal signup view.
	const isDuo = event.slug === DUO_WOLF_EVENT_SLUG;
	const startsAt = event.starts_at ? new Date(event.starts_at).getTime() : null;
	const eventLive = isDuo && event.status === 'open' && startsAt != null && Date.now() >= startsAt;
	const teamsView = eventLive && url.searchParams.get('view') === 'teams';
	let hasTeamEarly = false;
	if (eventLive) {
		const { data: su } = await supabase
			.from('vs_event_signups')
			.select('team_id')
			.eq('event_id', event.id)
			.eq('user_id', locals.user.id)
			.maybeSingle();
		hasTeamEarly = !!su?.team_id;
	}
	if (eventLive && hasTeamEarly && !teamsView) {
		throw redirect(307, `/events/${params.slug}/board`);
	}

	// One parallel round for everything that only needs the event row: signups + teams
	// (paginated past the 1000-row cap), the host lookup, and the caller's pending
	// invites. Host and invites used to be their own serial stages.
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
			.or(`from_user_id.eq.${locals.user.id},to_user_id.eq.${locals.user.id}`)
	]);

	const host: { rsn: string | null; discord_username: string | null } | null =
		hostRes.data ?? null;

	const signups = (signupsRaw ?? []) as unknown as SignupRow[];
	const teamNameById = new Map<string, string | null>(
		((teamsRaw ?? []) as { id: string; name: string | null }[]).map((t) => [t.id, t.name])
	);

	const mySignup = signups.find((s) => s.user_id === locals.user!.id) ?? null;

	const teamMap = new Map<string, SignupRow[]>();
	for (const s of signups) {
		if (!s.team_id) continue;
		const arr = teamMap.get(s.team_id) ?? [];
		arr.push(s);
		teamMap.set(s.team_id, arr);
	}

	const myTeam = mySignup?.team_id ? teamMap.get(mySignup.team_id) ?? [] : [];

	const soloPool = signups
		.filter((s) => !s.team_id && s.user_id !== locals.user!.id)
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
			incoming: invites.filter((i) => i.to_user_id === locals.user!.id),
			outgoing: invites.filter((i) => i.from_user_id === locals.user!.id)
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

	if (url.searchParams.get('demo') === '1') {
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
	const admin = isAdmin(locals.user);
	const adminSignups = admin
		? signups.map((s) => ({
				user_id: s.user_id,
				name: s.vs_users.rsn || s.vs_users.discord_username,
				team_id: s.team_id
			}))
		: [];

	// Standings (all teams + how far they've climbed, with clan tabs). Served whenever the
	// climb is live (the live event page = the solo landing + standings).
	let standings: DuoStandings | null = null;
	if (eventLive) {
		// Hand over the roster/teams this load already fetched so standings doesn't
		// re-issue the same two event-wide paginated reads.
		standings = await loadDuoStandings(
			event.id,
			mySignup?.team_id ?? null,
			{ topN: 9999, perClanCap: 9999, markersTopN: 0 },
			{
				teams: ((teamsRaw ?? []) as { id: string; name: string | null }[]),
				signups: signups.map((s) => ({ team_id: s.team_id, vs_users: s.vs_users }))
			}
		);
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
			isMe: m.user_id === locals.user!.id
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
};

function isEventOpen(event: { status: string; signup_closes_at: string | null }) {
	if (event.status !== 'open') return false;
	if (event.signup_closes_at && new Date(event.signup_closes_at) < new Date()) return false;
	return true;
}

// Put a signed-up player on a TEAM OF ONE so solos who never paired up can still play. The
// board is team-based, so a solo team participates exactly like a duo (just one member).
async function createSoloTeam(
	supabase: ReturnType<typeof db>,
	eventId: string,
	userId: string,
	rsn: string | null
): Promise<{ ok: boolean; error?: string }> {
	const { data: signup } = await supabase
		.from('vs_event_signups')
		.select('id, team_id')
		.eq('event_id', eventId)
		.eq('user_id', userId)
		.maybeSingle();
	if (!signup) return { ok: false, error: 'Join the event first.' };
	if (signup.team_id) return { ok: true }; // already on a team

	const { data: team, error: tErr } = await supabase
		.from('vs_teams')
		.insert({ event_id: eventId, name: rsn ?? null, created_by: userId })
		.select('id')
		.single();
	if (tErr || !team) return { ok: false, error: tErr?.message ?? 'Could not create your team' };

	// Race guard: only claim the signup if it's still un-teamed.
	const { error: uErr } = await supabase
		.from('vs_event_signups')
		.update({ team_id: team.id })
		.eq('id', signup.id)
		.is('team_id', null);
	if (uErr) return { ok: false, error: uErr.message };

	// They're teamed now — clear any pending invites in either direction.
	await supabase
		.from('vs_team_invites')
		.update({ status: 'cancelled', responded_at: new Date().toISOString() })
		.eq('event_id', eventId)
		.eq('status', 'pending')
		.or(`from_user_id.eq.${userId},to_user_id.eq.${userId}`);

	return { ok: true };
}

export const actions: Actions = {
	joinEvent: async ({ params, locals }) => {
		if (!locals.user) throw redirect(303, '/');
		if (!locals.user.rsn) throw redirect(303, '/onboarding');

		const supabase = db();

		const { data: event } = await supabase
			.from('vs_events')
			.select('id, status, signup_closes_at')
			.eq('slug', params.slug)
			.maybeSingle();

		if (!event) return fail(404, { error: 'Event not found' });
		if (!isEventOpen(event)) return fail(400, { error: 'Signups are closed' });

		const { error: insertError } = await supabase
			.from('vs_event_signups')
			.insert({ event_id: event.id, user_id: locals.user.id });

		if (insertError && !insertError.message.includes('duplicate')) {
			return fail(500, { error: insertError.message });
		}

		return { ok: true };
	},

	// Play solo: join the climb as a team of one (for players who didn't find a duo).
	goSolo: async ({ params, locals }) => {
		if (!locals.user) throw redirect(303, '/');
		if (!locals.user.rsn) throw redirect(303, '/onboarding');

		const supabase = db();
		const { data: event } = await supabase
			.from('vs_events')
			.select('id, status')
			.eq('slug', params.slug)
			.maybeSingle();
		if (!event) return fail(404, { error: 'Event not found' });
		if (event.status !== 'open') return fail(400, { error: 'This event is not open.' });

		const res = await createSoloTeam(supabase, event.id, locals.user.id, locals.user.rsn);
		if (!res.ok) return fail(400, { error: res.error });
		return { ok: true };
	},

	leaveEvent: async ({ params, locals }) => {
		if (!locals.user) throw redirect(303, '/');

		const supabase = db();

		const { data: event } = await supabase
			.from('vs_events')
			.select('id')
			.eq('slug', params.slug)
			.maybeSingle();

		if (!event) return fail(404, { error: 'Event not found' });

		const { data: mySignup } = await supabase
			.from('vs_event_signups')
			.select('id, team_id')
			.eq('event_id', event.id)
			.eq('user_id', locals.user.id)
			.maybeSingle();

		if (!mySignup) return fail(400, { error: "You haven't joined this event" });
		if (mySignup.team_id) {
			return fail(400, { error: 'Leave your team before leaving the event' });
		}

		// Tidy up any pending invites this player has open (in either direction)
		// so they don't linger after the signup is gone.
		await supabase
			.from('vs_team_invites')
			.update({ status: 'cancelled', responded_at: new Date().toISOString() })
			.eq('event_id', event.id)
			.eq('status', 'pending')
			.or(`from_user_id.eq.${locals.user.id},to_user_id.eq.${locals.user.id}`);

		const { error: delError } = await supabase
			.from('vs_event_signups')
			.delete()
			.eq('id', mySignup.id)
			.eq('user_id', locals.user.id);

		if (delError) return fail(500, { error: delError.message });

		return { ok: true };
	},

	inviteUser: async ({ params, locals, request }) => {
		if (!locals.user) throw redirect(303, '/');

		const form = await request.formData();
		const targetUserId = form.get('user_id')?.toString();
		if (!targetUserId) return fail(400, { error: 'Missing user_id' });
		if (targetUserId === locals.user.id) return fail(400, { error: "Can't invite yourself" });

		const supabase = db();

		const { data: event } = await supabase
			.from('vs_events')
			.select('id, status, signup_closes_at')
			.eq('slug', params.slug)
			.maybeSingle();

		if (!event) return fail(404, { error: 'Event not found' });
		if (!isEventOpen(event)) return fail(400, { error: 'Signups are closed' });

		const { data: signups } = await supabase
			.from('vs_event_signups')
			.select('user_id, team_id')
			.eq('event_id', event.id)
			.in('user_id', [locals.user.id, targetUserId]);

		const me = signups?.find((s) => s.user_id === locals.user!.id);
		const them = signups?.find((s) => s.user_id === targetUserId);

		if (!me) return fail(400, { error: 'You must join the event first' });
		if (!them) return fail(400, { error: "That player hasn't joined this event" });
		if (me.team_id) return fail(400, { error: "You're already on a team" });
		if (them.team_id) return fail(400, { error: 'That player is already on a team' });

		const { error: insertError } = await supabase.from('vs_team_invites').insert({
			event_id: event.id,
			from_user_id: locals.user.id,
			to_user_id: targetUserId
		});

		if (insertError) {
			if (insertError.message.includes('duplicate')) {
				return fail(409, { error: 'You already have a pending invite to this player' });
			}
			return fail(500, { error: insertError.message });
		}

		return { ok: true };
	},

	cancelInvite: async ({ locals, request }) => {
		if (!locals.user) throw redirect(303, '/');

		const form = await request.formData();
		const inviteId = form.get('invite_id')?.toString();
		if (!inviteId) return fail(400, { error: 'Missing invite_id' });

		const { error: updateError } = await db()
			.from('vs_team_invites')
			.update({ status: 'cancelled', responded_at: new Date().toISOString() })
			.eq('id', inviteId)
			.eq('from_user_id', locals.user.id)
			.eq('status', 'pending');

		if (updateError) return fail(500, { error: updateError.message });

		return { ok: true };
	},

	declineInvite: async ({ locals, request }) => {
		if (!locals.user) throw redirect(303, '/');

		const form = await request.formData();
		const inviteId = form.get('invite_id')?.toString();
		if (!inviteId) return fail(400, { error: 'Missing invite_id' });

		const { error: updateError } = await db()
			.from('vs_team_invites')
			.update({ status: 'declined', responded_at: new Date().toISOString() })
			.eq('id', inviteId)
			.eq('to_user_id', locals.user.id)
			.eq('status', 'pending');

		if (updateError) return fail(500, { error: updateError.message });

		return { ok: true };
	},

	acceptInvite: async ({ locals, request }) => {
		if (!locals.user) throw redirect(303, '/');

		const form = await request.formData();
		const inviteId = form.get('invite_id')?.toString();
		if (!inviteId) return fail(400, { error: 'Missing invite_id' });

		const { error: rpcError } = await db().rpc('vs_accept_invite', {
			p_invite_id: inviteId,
			p_user_id: locals.user.id
		});

		if (rpcError) {
			const msg = rpcError.message || 'Could not accept invite';
			const friendly =
				msg.includes('inviter_already_teamed') || msg.includes('invitee_already_teamed')
					? 'One of you was already teamed up — refresh and try again'
					: msg.includes('invite_not_pending')
						? 'That invite is no longer pending'
						: msg.includes('event_not_open')
							? 'Signups are closed for this event'
							: msg;
			return fail(400, { error: friendly });
		}

		return { ok: true };
	},

	leaveTeam: async ({ params, locals }) => {
		if (!locals.user) throw redirect(303, '/');

		const supabase = db();

		const { data: event } = await supabase
			.from('vs_events')
			.select('id')
			.eq('slug', params.slug)
			.maybeSingle();

		if (!event) return fail(404, { error: 'Event not found' });

		const { data: mySignup } = await supabase
			.from('vs_event_signups')
			.select('team_id')
			.eq('event_id', event.id)
			.eq('user_id', locals.user.id)
			.maybeSingle();

		if (!mySignup?.team_id) return fail(400, { error: "You're not on a team" });

		const teamId = mySignup.team_id;

		const { error: clearError } = await supabase
			.from('vs_event_signups')
			.update({ team_id: null })
			.eq('event_id', event.id)
			.eq('team_id', teamId);

		if (clearError) return fail(500, { error: clearError.message });

		await supabase.from('vs_teams').delete().eq('id', teamId);

		return { ok: true };
	},

	setTeamName: async ({ params, locals, request }) => {
		if (!locals.user) throw redirect(303, '/');

		const form = await request.formData();
		const rawName = form.get('name')?.toString().trim() ?? '';
		const name = rawName.length === 0 ? null : rawName;

		if (name !== null && name.length > 32) {
			return fail(400, { error: 'Team name must be 32 characters or fewer' });
		}

		const supabase = db();

		const { data: event } = await supabase
			.from('vs_events')
			.select('id, status, starts_at')
			.eq('slug', params.slug)
			.maybeSingle();

		if (!event) return fail(404, { error: 'Event not found' });

		// Team names lock once the climb has started (open + past starts_at) — mirrors the
		// load's `eventLive`, so the button is hidden AND the action is refused after go-live.
		const startsAt = event.starts_at ? new Date(event.starts_at).getTime() : null;
		const started = event.status === 'open' && startsAt != null && Date.now() >= startsAt;
		if (started) {
			return fail(400, { error: 'Team names are locked once the event has started.' });
		}

		const { data: mySignup } = await supabase
			.from('vs_event_signups')
			.select('team_id')
			.eq('event_id', event.id)
			.eq('user_id', locals.user.id)
			.maybeSingle();

		if (!mySignup?.team_id) return fail(400, { error: "You're not on a team" });

		const { error: updateError } = await supabase
			.from('vs_teams')
			.update({ name })
			.eq('id', mySignup.team_id);

		if (updateError) return fail(500, { error: updateError.message });

		return { ok: true };
	},

	// --- Admin: remove a player from the event (kicks their signup) -----------
	// If they're on a team, the team is disbanded first (their teammate is freed back
	// to the solo pool), then their signup + any pending invites are cleared.
	adminRemoveSignup: async ({ params, locals, request }) => {
		if (!locals.user) throw redirect(303, '/');
		if (!isAdmin(locals.user)) return fail(403, { error: 'Not allowed' });

		const form = await request.formData();
		const targetUserId = form.get('user_id')?.toString();
		if (!targetUserId) return fail(400, { error: 'Pick a player to remove' });

		const supabase = db();
		const { data: event } = await supabase
			.from('vs_events')
			.select('id')
			.eq('slug', params.slug)
			.maybeSingle();
		if (!event) return fail(404, { error: 'Event not found' });

		const { data: signup } = await supabase
			.from('vs_event_signups')
			.select('id, team_id')
			.eq('event_id', event.id)
			.eq('user_id', targetUserId)
			.maybeSingle();
		if (!signup) return fail(400, { error: 'That player is not signed up' });

		// Disband their team first (frees the teammate back to solo).
		if (signup.team_id) {
			await supabase
				.from('vs_event_signups')
				.update({ team_id: null })
				.eq('event_id', event.id)
				.eq('team_id', signup.team_id);
			await supabase.from('vs_teams').delete().eq('id', signup.team_id);
		}

		// Clear any pending invites involving them.
		await supabase
			.from('vs_team_invites')
			.update({ status: 'cancelled', responded_at: new Date().toISOString() })
			.eq('event_id', event.id)
			.eq('status', 'pending')
			.or(`from_user_id.eq.${targetUserId},to_user_id.eq.${targetUserId}`);

		const { error: delError } = await supabase
			.from('vs_event_signups')
			.delete()
			.eq('event_id', event.id)
			.eq('user_id', targetUserId);
		if (delError) return fail(500, { error: delError.message });

		return { ok: true };
	},

	// --- Admin: manually pair two solo players into a team --------------------
	adminPairUsers: async ({ params, locals, request }) => {
		if (!locals.user) throw redirect(303, '/');
		if (!isAdmin(locals.user)) return fail(403, { error: 'Not allowed' });

		const form = await request.formData();
		const userA = form.get('user_a')?.toString();
		const userB = form.get('user_b')?.toString();
		if (!userA || !userB) return fail(400, { error: 'Pick two players' });
		if (userA === userB) return fail(400, { error: 'Pick two different players' });

		const supabase = db();
		const { data: event } = await supabase
			.from('vs_events')
			.select('id')
			.eq('slug', params.slug)
			.maybeSingle();
		if (!event) return fail(404, { error: 'Event not found' });

		const { data: signups } = await supabase
			.from('vs_event_signups')
			.select('id, user_id, team_id')
			.eq('event_id', event.id)
			.in('user_id', [userA, userB]);
		const sa = signups?.find((s) => s.user_id === userA);
		const sb = signups?.find((s) => s.user_id === userB);
		if (!sa || !sb) return fail(400, { error: 'Both players must be signed up for this event' });
		if (sa.team_id || sb.team_id) {
			return fail(400, { error: 'Both players must be solo — one is already on a team' });
		}

		// Create the team, then assign both signups optimistically (only while still
		// solo). If either lost the race, undo and bail so we never half-pair.
		const { data: team, error: teamErr } = await supabase
			.from('vs_teams')
			.insert({ event_id: event.id, created_by: locals.user.id })
			.select('id')
			.single();
		if (teamErr || !team) return fail(500, { error: teamErr?.message ?? 'Could not create team' });

		const { count: ca } = await supabase
			.from('vs_event_signups')
			.update({ team_id: team.id }, { count: 'exact' })
			.eq('id', sa.id)
			.is('team_id', null);
		const { count: cb } = await supabase
			.from('vs_event_signups')
			.update({ team_id: team.id }, { count: 'exact' })
			.eq('id', sb.id)
			.is('team_id', null);

		if (!ca || !cb) {
			await supabase.from('vs_event_signups').update({ team_id: null }).eq('team_id', team.id);
			await supabase.from('vs_teams').delete().eq('id', team.id);
			return fail(409, { error: 'One of those players just got teamed up — refresh and try again' });
		}

		// Clear any pending invites involving either of them.
		for (const uid of [userA, userB]) {
			await supabase
				.from('vs_team_invites')
				.update({ status: 'cancelled', responded_at: new Date().toISOString() })
				.eq('event_id', event.id)
				.eq('status', 'pending')
				.or(`from_user_id.eq.${uid},to_user_id.eq.${uid}`);
		}

		return { ok: true };
	}
};
