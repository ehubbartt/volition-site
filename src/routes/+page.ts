import { redirect } from '@sveltejs/kit';
import { CATEGORY_OPTIONS, type CalendarItem } from '$lib/calendar';
import { EMPTY_DIRECTORY, EMPTY_STATS, type Directory, type Stats, type TaskSummary } from '$lib/home';
import type { PageLoad } from './$types';

// UNIVERSAL load, no server load: navigating home never waits on the network.
// The onboarding gate runs against the layout's already-loaded user, the page
// renders its shell + skeletons immediately, and each panel streams in from
// /api/home. Every promise carries a catch fallback so a failed fetch degrades
// to an empty panel instead of an error page.
export const load: PageLoad = async ({ parent, fetch }) => {
	const { user } = await parent();

	// Logged in but not onboarded → finish onboarding first.
	if (user && (!user.rsn || !user.clan_allegiance || !user.account_type)) {
		redirect(303, '/onboarding');
	}

	const main = fetch('/api/home?part=main').then((r) => {
		if (!r.ok) throw new Error(`home main ${r.status}`);
		return r.json() as Promise<{ calendar: CalendarItem[]; stats: Stats }>;
	});

	return {
		calendar: main.then((m) => m.calendar).catch(() => [] as CalendarItem[]),
		stats: main.then((m) => m.stats).catch(() => EMPTY_STATS),
		directory: fetch('/api/home?part=directory')
			.then((r) => {
				if (!r.ok) throw new Error(`home directory ${r.status}`);
				return r.json() as Promise<Directory>;
			})
			.catch(() => EMPTY_DIRECTORY),
		taskSummary: user
			? fetch('/api/home?part=tasks')
					.then((r) => {
						if (!r.ok) throw new Error(`home tasks ${r.status}`);
						return r.json() as Promise<TaskSummary | null>;
					})
					.catch(() => null)
			: Promise.resolve(null),
		categoryOptions: CATEGORY_OPTIONS
	};
};
