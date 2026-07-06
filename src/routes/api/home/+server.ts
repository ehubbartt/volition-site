import { json, error } from '@sveltejs/kit';
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
// (calendar/stats) never wait on the slow ones (full roster, task fan-out). The
// page has NO server load — its universal load fires these fetches without
// awaiting, so navigating home completes instantly and each panel streams in.
export const GET: RequestHandler = async ({ locals, url }) => {
	const user = locals.user;
	const part = url.searchParams.get('part') ?? 'main';
	const headers = { 'cache-control': 'no-store' };

	switch (part) {
		case 'main': {
			const admin = user ? isAdmin(user) : false;
			const [calendar, stats] = await Promise.all([
				// Shared per role → micro-cached; calendar actions bust this so an admin
				// sees their new entry immediately.
				microCached(`home:calendar:${admin}`, 15_000, () => loadCalendarItems(admin)),
				buildStats(!!user)
			]);
			return json({ calendar, stats }, { headers });
		}
		case 'directory': {
			const directory = user ? await buildDirectory(user) : await buildPublicDirectory();
			return json(directory, { headers });
		}
		case 'tasks': {
			const summary =
				user && user.rsn && user.clan_allegiance && user.account_type
					? await buildTaskSummary(user)
					: null;
			return json(summary, { headers });
		}
		default:
			throw error(400, 'Unknown part');
	}
};
