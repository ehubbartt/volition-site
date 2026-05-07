import { redirect } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) throw redirect(303, '/');
	if (!locals.user.rsn || !locals.user.clan_allegiance || !locals.user.account_type) {
		throw redirect(303, '/onboarding');
	}

	const { data: events, error } = await db()
		.from('vs_events')
		.select('id, slug, name, description, status, signup_opens_at, signup_closes_at')
		.in('status', ['open', 'locked'])
		.order('created_at', { ascending: false });

	if (error) throw new Error(error.message);

	return { events: events ?? [] };
};
