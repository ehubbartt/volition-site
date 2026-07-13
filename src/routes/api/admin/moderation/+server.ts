import { adminEndpoint } from '$lib/server/apiEndpoint';
import { buildModeration } from '$lib/server/admin/moderation';
import type { RequestHandler } from './$types';

// Data for /admin/moderation (instant navigation). adminEndpoint re-checks the
// admin role server-side on every fetch.
export const GET: RequestHandler = adminEndpoint(() => buildModeration());
