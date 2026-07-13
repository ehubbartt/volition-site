import { adminEndpoint } from '$lib/server/apiEndpoint';
import { buildEvents } from '$lib/server/admin/events';
import type { RequestHandler } from './$types';

// Data for /admin/events (instant navigation). adminEndpoint re-checks the
// admin role server-side on every fetch.
export const GET: RequestHandler = adminEndpoint(() => buildEvents());
