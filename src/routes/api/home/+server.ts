import { error } from '@sveltejs/kit';
import { publicEndpoint } from '$lib/server/apiEndpoint';
import { isAdmin } from '$lib/server/auth';
import { loadCalendarItems } from '$lib/server/calendar';
import { microCached } from '$lib/server/microCache';
import {
	buildStats,
	buildDirectory,
	buildPublicDirectory,
	buildTaskSummary
} from '$lib/server/homeData';
import type { RequestHandler } from './$types';

// Data for the homepage, split into independently-fetched parts so the fast ones
// (calendar/stats) never wait on the slow ones (full roster, task fan-out).
// Public: the logged-out homepage renders too (instant navigation).
export const GET: RequestHandler = publicEndpoint(async (user, event) => {
	const part = event.url.searchParams.get('part') ?? 'main';
	switch (part) {
		case 'main': {
			const admin = user ? isAdmin(user) : false;
			const [calendar, stats] = await Promise.all([
				// Shared per role → micro-cached; calendar actions bust this so an admin
				// sees their new entry immediately.
				microCached(`home:calendar:${admin}`, 15_000, () => loadCalendarItems(admin)),
				buildStats(!!user)
			]);
			return { calendar, stats };
		}
		case 'directory':
			return user ? buildDirectory(user) : buildPublicDirectory();
		case 'tasks':
			return user && user.rsn && user.clan_allegiance && user.account_type
				? buildTaskSummary(user)
				: null;
		default:
			throw error(400, 'Unknown part');
	}
});
