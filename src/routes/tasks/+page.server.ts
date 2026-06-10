import { redirect } from '@sveltejs/kit';
import { loadPlayerTasks } from '$lib/server/tasks';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) throw redirect(303, '/');
	if (!locals.user.rsn || !locals.user.clan_allegiance || !locals.user.account_type) {
		throw redirect(303, '/onboarding');
	}

	const tasks = await loadPlayerTasks(locals.user);
	return { tasks };
};
