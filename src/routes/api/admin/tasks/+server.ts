import { adminEndpoint } from '$lib/server/apiEndpoint';
import { buildTasks } from '$lib/server/admin/tasks';
import type { RequestHandler } from './$types';

// Data for /admin/tasks (instant navigation). adminEndpoint re-checks the
// admin role server-side on every fetch.
export const GET: RequestHandler = adminEndpoint(() => buildTasks());
