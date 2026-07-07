import { redirect, fail, error } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { isAdmin } from '$lib/server/auth';
import { bingoActions } from '$lib/server/bingoPage';
import type { Actions } from './$types';

// ACTIONS ONLY — this page has no server load. Its data comes from
// /api/events/[slug] (built in $lib/server/eventDetail.ts) via the universal
// load in +page.ts, so navigating to an event never waits on the server.

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
	// Bingo boards are served on this URL too — their submit/remove/adminReject
	// actions ride along (no name overlap with the signup/team actions below).
	...bingoActions,
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
