import { instantGuard } from '$lib/instantLoad';
import { CATEGORY_OPTIONS, type CalendarItem } from '$lib/calendar';
import type { Directory, Stats, TaskSummary } from '$lib/home';
import { swr, mapSwr, emptySwr } from '$lib/swr';
import type { PageLoad } from './$types';

// Instant navigation (see docs/ARCHITECTURE.md); hand-composed because the
// homepage streams several independently-fetched parts, two of which are
// live views over one shared /api/home?part=main response.
export const load: PageLoad = async ({ parent, fetch }) => {
	const { user } = await parent();
	instantGuard(user, 'public');

	const main = swr<{ calendar: CalendarItem[]; stats: Stats }>(fetch, '/api/home?part=main');

	return {
		calendar: mapSwr(main, (m) => m.calendar),
		stats: mapSwr(main, (m) => m.stats),
		directory: swr<Directory>(fetch, '/api/home?part=directory'),
		taskSummary: user ? swr<TaskSummary | null>(fetch, '/api/home?part=tasks') : emptySwr<TaskSummary | null>(),
		categoryOptions: CATEGORY_OPTIONS
	};
};
