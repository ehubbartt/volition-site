import { instantGuard } from '$lib/instantLoad';
import type { PlayerTask } from '$lib/tasks';
import { mapSwr, swr } from '$lib/swr';
import type { PageLoad } from './$types';

// Instant navigation (see docs/ARCHITECTURE.md); hand-composed because the
// endpoint wraps the list in { tasks } and the page wants the bare array.
export const load: PageLoad = async ({ parent, fetch }) => {
	const data = await parent();
	instantGuard(data, 'onboarded');
	return { tasks: mapSwr(swr<{ tasks: PlayerTask[] }>(fetch, '/api/tasks'), (j) => j.tasks) };
};
