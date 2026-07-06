import { redirect } from '@sveltejs/kit';
import type { PlayerTask } from '$lib/tasks';
import { swr, type Swr } from '$lib/swr';
import type { PageLoad } from './$types';

// UNIVERSAL load, no server load: navigating to the To Do page never waits on
// the network — the list streams in from /api/tasks behind skeletons.
export const load: PageLoad = async ({ parent, fetch }) => {
	const { user } = await parent();
	if (!user) redirect(303, '/');
	if (!user.rsn || !user.clan_allegiance || !user.account_type) {
		redirect(303, '/onboarding');
	}

	// Stale-while-revalidate: revisits render the last-seen list instantly while
	// a background refetch swaps in fresh data.
	const raw = swr<{ tasks: PlayerTask[] }>(fetch, '/api/tasks');
	const tasks: Swr<PlayerTask[]> = {
		cached: raw.cached?.tasks ?? null,
		fresh: raw.fresh.then((j) => j?.tasks ?? null)
	};

	return { tasks };
};
