import { redirect, fail, error } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { isAdmin } from '$lib/server/auth';
import { logAudit } from '$lib/server/audit';
import {
	SIGNUP_EVENT_KIND,
	convertRoster,
	convertTargets,
	loadRoster,
	loadSignupEvent,
	removeSignup,
	saveForm,
	signupWindow
} from '$lib/server/signupForm';
import { MAX_QUESTIONS, type SignupQuestion } from '$lib/events/signupForm';
import type { Actions, PageServerLoad } from './$types';

// The admin's side of a signup event: write the questions, read the answers, and hand
// the people over to whatever event gets built out of them.

export const load: PageServerLoad = async ({ locals, params }) => {
	if (!locals.user) throw redirect(303, '/');
	if (!isAdmin(locals.user)) throw error(403, 'Not allowed');

	// Refuse a non-signup event outright. The roster would render fine, but saving
	// questions would write a `signupForm` key into (say) a bingo's structure, where
	// nothing reads it and the bingo normalizer strips it on the next builder save — an
	// admin's work quietly lost rather than refused.
	const { data: kindRow } = await db()
		.from('vs_events')
		.select('kind')
		.eq('slug', params.slug)
		.maybeSingle();
	if (!kindRow) throw error(404, 'No event with that slug');
	const kind = (kindRow as { kind: string }).kind;
	if (kind !== SIGNUP_EVENT_KIND) {
		throw error(400, `"${params.slug}" is a ${kind} event, not a signup form`);
	}

	const event = await loadSignupEvent(params.slug);
	if (!event) throw error(404, 'No event with that slug');

	const [roster, targets] = await Promise.all([
		loadRoster(event.id),
		convertTargets(event.id)
	]);

	return { event, roster, targets, window: signupWindow(event) };
};

function requireAdmin(locals: App.Locals) {
	if (!locals.user || !isAdmin(locals.user)) return fail(403, { error: 'Admins only' });
	return null;
}

/**
 * The question editor posts its whole list as one JSON blob rather than as N indexed form
 * fields. Add/remove/reorder is all client-side state, and serialising it once keeps
 * ordering honest — indexed fields silently reorder when a middle row is deleted.
 */
function parseQuestions(raw: string): SignupQuestion[] | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return null;
	}
	if (!Array.isArray(parsed)) return null;
	// `normalizeForm` does the real validation on the way into the database; this only has
	// to stop something that isn't a list of objects from getting that far.
	return parsed.slice(0, MAX_QUESTIONS) as SignupQuestion[];
}

export const actions: Actions = {
	saveForm: async (event) => {
		const { locals, params, request } = event;
		const denied = requireAdmin(locals);
		if (denied) return denied;

		const ev = await loadSignupEvent(params.slug);
		if (!ev) return fail(404, { error: 'Event not found' });

		const form = await request.formData();
		const questions = parseQuestions(form.get('questions')?.toString() ?? '[]');
		if (!questions) return fail(400, { error: 'Could not read the questions' });

		const res = await saveForm({
			eventId: ev.id,
			questions,
			intro: form.get('intro')?.toString() ?? '',
			allowEdits: form.get('allow_edits') === 'on'
		});
		if (!res.ok) return fail(400, { error: res.error });

		const kept = res.value?.questions.length ?? 0;
		const dropped = questions.length - kept;
		return {
			ok: true,
			report:
				dropped > 0
					? `Saved ${kept} question${kept === 1 ? '' : 's'} — ${dropped} was dropped for having no text`
					: `Saved ${kept} question${kept === 1 ? '' : 's'}`
		};
	},

	// Take someone off the list. Unlike the member's own withdraw, this works after the
	// window has shut — which is when an admin actually needs it.
	remove: async (event) => {
		const { locals, params, request } = event;
		const denied = requireAdmin(locals);
		if (denied) return denied;

		const ev = await loadSignupEvent(params.slug);
		if (!ev) return fail(404, { error: 'Event not found' });

		const form = await request.formData();
		const userId = form.get('user_id')?.toString() ?? '';
		if (!userId) return fail(400, { error: 'No player given' });

		const res = await removeSignup({ eventId: ev.id, userId });
		if (!res.ok) return fail(400, { error: res.error });

		await logAudit(event, 200, { action: 'signup.remove', slug: params.slug, userId });
		return { ok: true, report: 'Removed them from the signup' };
	},

	// The handoff: push the selected people into the event that actually got built.
	convert: async (event) => {
		const { locals, params, request } = event;
		const denied = requireAdmin(locals);
		if (denied) return denied;

		const ev = await loadSignupEvent(params.slug);
		if (!ev) return fail(404, { error: 'Event not found' });

		const form = await request.formData();
		const targetSlug = form.get('target_slug')?.toString() ?? '';
		const userIds = form.getAll('user_id').map((v) => v.toString()).filter(Boolean);

		const res = await convertRoster({ sourceEventId: ev.id, targetSlug, userIds });
		if (!res.ok) return fail(400, { error: res.error });

		const r = res.value!;
		await logAudit(event, 200, {
			action: 'signup.convert',
			from: params.slug,
			to: r.targetSlug,
			added: r.added,
			alreadyThere: r.alreadyThere
		});

		const bits = [`Added ${r.added} to ${r.targetName}`];
		if (r.alreadyThere) bits.push(`${r.alreadyThere} were already in it`);
		return { ok: true, report: bits.join(' · '), convertedTo: r.targetSlug };
	}
};
