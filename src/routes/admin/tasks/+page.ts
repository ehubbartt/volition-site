import { instantLoad } from '$lib/instantLoad';
import type { buildTasks } from '$lib/server/admin/tasks';
import type { PageLoad } from './$types';

// Type-only import above is erased at build time. The 'admin' guard is UX only —
// the /api/admin endpoint re-checks the role on every fetch.
export type TasksData = Awaited<ReturnType<typeof buildTasks>>;

export const load: PageLoad = instantLoad<TasksData, 'tasks'>({
	key: 'tasks',
	guard: 'admin',
	url: '/api/admin/tasks'
});
