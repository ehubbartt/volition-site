import { adminEndpoint } from '$lib/server/apiEndpoint';
import { buildAdminStats } from '$lib/server/admin/stats';
import type { RequestHandler } from './$types';

// Data for /admin/stats (instant navigation). adminEndpoint re-checks the
// admin role server-side on every fetch.
export const GET: RequestHandler = adminEndpoint(() => buildAdminStats());
