import { redirect } from '@sveltejs/kit';
import { CATEGORY_OPTIONS, type CalendarItem } from '$lib/calendar';
import type { Directory, Stats, TaskSummary } from '$lib/home';
import { swr, emptySwr, type Swr } from '$lib/swr';
import type { PageLoad } from './$types';

// UNIVERSAL load, no server load: navigating home never waits on the network.
// Each panel is a stale-while-revalidate pair — revisits render the last-seen
// content instantly while a background refetch swaps in fresh data.
export const load: PageLoad = async ({ parent, fetch }) => {
	const { user } = await parent();

	// Logged in but not onboarded → finish onboarding first.
	if (user && (!user.rsn || !user.clan_allegiance || !user.account_type)) {
		redirect(303, '/onboarding');
	}

	const main = swr<{ calendar: CalendarItem[]; stats: Stats }>(fetch, '/api/home?part=main');

	return {
		calendar: {
			cached: main.cached?.calendar ?? null,
			fresh: main.fresh.then((m) => m?.calendar ?? null)
		} satisfies Swr<CalendarItem[]>,
		stats: {
			cached: main.cached?.stats ?? null,
			fresh: main.fresh.then((m) => m?.stats ?? null)
		} satisfies Swr<Stats>,
		directory: swr<Directory>(fetch, '/api/home?part=directory'),
		taskSummary: user ? swr<TaskSummary | null>(fetch, '/api/home?part=tasks') : emptySwr<TaskSummary | null>(),
		categoryOptions: CATEGORY_OPTIONS
	};
};
