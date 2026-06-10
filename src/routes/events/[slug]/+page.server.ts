import { redirect, fail, error } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { CLAN_LABEL, CLAN_OPTIONS } from '$lib/clans';
import { ACCOUNT_TYPES } from '$lib/accountTypes';
import { renderMarkdown } from '$lib/markdown';
import { isAdmin } from '$lib/server/auth';
import { BINGO_EVENT_SLUG } from '$lib/bingo/config';
import { isTaskEvent } from '$lib/events/simple';
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
		.select('id, slug, name, kind, description, status, signup_opens_at, signup_closes_at, team_size')
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

	const [{ data: signupsRaw }, { data: teamsRaw }] = await Promise.all([
		supabase
			.from('vs_event_signups')
			.select(
				'id, user_id, team_id, joined_at, vs_users(id, rsn, discord_username, clan_allegiance, account_type)'
			)
			.eq('event_id', event.id)
			.order('joined_at', { ascending: true }),
		supabase.from('vs_teams').select('id, name').eq('event_id', event.id)
	]);

	const signups = (signupsRaw ?? []) as unknown as SignupRow[];
	const teamNameById = new Map<string, string | null>(
		(teamsRaw ?? []).map((t) => [t.id, t.name])
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

	let pendingInvites: { incoming: InviteRow[]; outgoing: InviteRow[] } = {
		incoming: [],
		outgoing: []
	};

	if (mySignup && !mySignup.team_id) {
		const { data: invitesRaw } = await supabase
			.from('vs_team_invites')
			.select('id, from_user_id, to_user_id, created_at')
			.eq('event_id', event.id)
			.eq('status', 'pending')
			.or(`from_user_id.eq.${locals.user.id},to_user_id.eq.${locals.user.id}`);

		const invites = (invitesRaw ?? []) as InviteRow[];
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

	return {
		event: { ...event, description_html: renderMarkdown(event.description) },
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

		const { error: updateError } = await supabase
			.from('vs_teams')
			.update({ name })
			.eq('id', mySignup.team_id);

		if (updateError) return fail(500, { error: updateError.message });

		return { ok: true };
	}
};
