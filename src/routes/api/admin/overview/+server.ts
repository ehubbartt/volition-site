import { adminEndpoint } from '$lib/server/apiEndpoint';
import { buildOverview } from '$lib/server/admin/overview';
import type { RequestHandler } from './$types';

// Data for /admin/overview (instant navigation). adminEndpoint re-checks the
// admin role server-side on every fetch.
export const GET: RequestHandler = adminEndpoint(() => buildOverview());
