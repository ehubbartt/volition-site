import { fail, redirect } from '@sveltejs/kit';
import { loadSignupEvent, submitSignup, withdrawSignup } from '$lib/server/signupForm';
import type { Actions } from './$types';

// ACTIONS ONLY — this page has no server load. Its data comes from /api/signup/[slug]
// (built in $lib/server/signupPage.ts) via the universal load in +page.ts, so navigating
// here never waits on the server. See docs/PAGES.md.
//
// `loadSignupEvent` returns null for anything that is not a signup event, and both actions
// bail on null. That check is the one that matters: a POST never runs a `load`, so guarding
// only there would leave these actions able to join or un-join any open event on the site.

export const actions: Actions = {
	submit: async ({ locals, params, request }) => {
		if (!locals.user) throw redirect(303, '/');
		if (!locals.user.rsn) throw redirect(303, '/onboarding');

		const event = await loadSignupEvent(params.slug);
		if (!event) return fail(404, { error: 'Event not found' });

		const form = await request.formData();
		// Built from the FORM's question ids, never from the posted keys, so a crafted POST
		// cannot add fields to the answers jsonb.
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
		if (!locals.user) throw redirect(303, '/');

		const event = await loadSignupEvent(params.slug);
		if (!event) return fail(404, { error: 'Event not found' });

		const res = await withdrawSignup({ event, userId: locals.user.id });
		return res.ok ? { ok: true, withdrawn: true } : fail(400, { error: res.error });
	}
};
