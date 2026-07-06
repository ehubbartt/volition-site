import { redirect } from '@sveltejs/kit';
import type { PlayerTask } from '$lib/tasks';
import type { PageLoad } from './$types';

// UNIVERSAL load, no server load: navigating to the To Do page never waits on
// the network — the list streams in from /api/tasks behind skeletons.
export const load: PageLoad = async ({ parent, fetch }) => {
	const { user } = await parent();
	if (!user) redirect(303, '/');
	if (!user.rsn || !user.clan_allegiance || !user.account_type) {
		redirect(303, '/onboarding');
	}

	const tasks: Promise<PlayerTask[] | null> = fetch('/api/tasks')
		.then((r) => {
			if (!r.ok) throw new Error(`tasks ${r.status}`);
			return r.json() as Promise<{ tasks: PlayerTask[] }>;
		})
		.then((j) => j.tasks)
		.catch(() => null);

	return { tasks };
};
