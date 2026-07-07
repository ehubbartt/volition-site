import { memberEndpoint } from '$lib/server/apiEndpoint';
import { loadPlayerTasks } from '$lib/server/tasks';
import type { RequestHandler } from './$types';

// Data for the /tasks (To Do) page (instant navigation — see docs/ARCHITECTURE.md).
export const GET: RequestHandler = memberEndpoint(async (user) => ({
	tasks: await loadPlayerTasks(user)
}));
