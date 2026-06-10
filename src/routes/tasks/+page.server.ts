import { redirect, error } from '@sveltejs/kit';
import { isCardTester } from '$lib/server/auth';
import { loadPlayerTasks } from '$lib/server/tasks';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) throw redirect(303, '/');
	if (!locals.user.rsn || !locals.user.clan_allegiance || !locals.user.account_type) {
		throw redirect(303, '/onboarding');
	}
	// Card-testers only for now (mirrors the /gamba gating).
	if (!isCardTester(locals.user)) throw error(403, 'Not allowed');

	const tasks = await loadPlayerTasks(locals.user);
	return { tasks };
};
