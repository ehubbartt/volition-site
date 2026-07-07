import { adminEndpoint } from '$lib/server/apiEndpoint';
import { buildDinkDrops } from '$lib/server/admin/dinkDrops';
import type { RequestHandler } from './$types';

// Data for /admin/dink-drops (instant navigation). adminEndpoint re-checks the
// admin role server-side on every fetch.
export const GET: RequestHandler = adminEndpoint((_user, event) =>
	buildDinkDrops(event.url.searchParams.get('show'))
);
