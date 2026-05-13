import { redirect, error } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params, locals }) => {
	if (!locals.user) throw redirect(303, '/');
	if (!locals.user.rsn || !locals.user.clan_allegiance || !locals.user.account_type) {
		throw redirect(303, '/onboarding');
	}

	const { data: event, error: eventErr } = await db()
		.from('vs_events')
		.select('id, slug, name, status')
		.eq('slug', params.slug)
		.maybeSingle();

	if (eventErr) throw error(500, eventErr.message);
	if (!event) throw error(404, 'Event not found');

	return { event };
};
