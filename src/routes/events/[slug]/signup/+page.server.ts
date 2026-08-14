import { redirect, fail, error } from '@sveltejs/kit';
import { isAdmin } from '$lib/server/auth';
import {
	SIGNUP_EVENT_KIND,
	loadMySignup,
	loadRoster,
	loadSignupEvent,
	signupWindow,
	submitSignup,
	withdrawSignup
} from '$lib/server/signupForm';
import { db } from '$lib/server/db';
import type { Actions, PageServerLoad } from './$types';

// The member's side of a signup event: read the questions, answer them, change your mind.
//
// This is its own route rather than a branch of /events/[slug] for the same reason
// Battleship is: that page is the DuoWolf pairing flow, and an event served there offers
// "invite them to duo" and a "View board →" link to a board that does not exist. A signup
// has neither teams nor a board.

export const load: PageServerLoad = async ({ locals, params }) => {
	if (!locals.user) throw redirect(303, '/');
	// An RSN is what makes a signup useful to whoever builds the event afterwards — a list
	// of Discord names you cannot match to accounts is not a roster.
	if (!locals.user.rsn) throw redirect(303, '/onboarding');

	const { data: kindRow } = await db()
		.from('vs_events')
		.select('kind')
		.eq('slug', params.slug)
		.maybeSingle();
	if (!kindRow) throw error(404, 'No event with that slug');
	if ((kindRow as { kind: string }).kind !== SIGNUP_EVENT_KIND) {
		throw redirect(303, `/events/${params.slug}`);
	}

	const event = await loadSignupEvent(params.slug);
	if (!event) throw error(404, 'No event with that slug');

	const admin = isAdmin(locals.user);
	// Draft and preview events are invisible until an admin opens them, the same rule the
	// generic event detail applies.
	if ((event.status === 'draft' || event.status === 'preview') && !admin) {
		throw error(404, 'No event with that slug');
	}

	const [mine, roster] = await Promise.all([
		loadMySignup(event.id, locals.user.id),
		loadRoster(event.id)
	]);

	return {
		event,
		window: signupWindow(event),
		mine,
		isAdmin: admin,
		// The count is public — "42 people are in" is the social proof that makes the next
		// person sign up. The ANSWERS are not: someone's availability is theirs, and a
		// public list of who can play least is a way to be picked last in front of everyone.
		signedUpCount: roster.length,
		names: roster.map((r) => r.rsn).filter((n): n is string => !!n)
	};
};

export const actions: Actions = {
	submit: async ({ locals, params, request }) => {
		if (!locals.user) return fail(403, { error: 'Sign in first' });

		const event = await loadSignupEvent(params.slug);
		if (!event) return fail(404, { error: 'Event not found' });

		const form = await request.formData();
		const raw: Record<string, unknown> = {};
		for (const q of event.form.questions) raw[q.id] = form.get(q.id) ?? '';

		const res = await submitSignup({ event, userId: locals.user.id, raw });
		if (!res.ok) {
			// Field errors ride back so each input can show its own problem rather than one
			// banner saying "something is wrong" above a form of twelve fields.
			return fail(400, { error: res.error, fieldErrors: res.fieldErrors ?? {} });
		}
		return { ok: true, created: res.value?.created ?? false };
	},

	withdraw: async ({ locals, params }) => {
		if (!locals.user) return fail(403, { error: 'Sign in first' });
		const event = await loadSignupEvent(params.slug);
		if (!event) return fail(404, { error: 'Event not found' });

		const res = await withdrawSignup({ event, userId: locals.user.id });
		return res.ok ? { ok: true, withdrawn: true } : fail(400, { error: res.error });
	}
};
