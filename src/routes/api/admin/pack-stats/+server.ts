import { cardAdminEndpoint } from '$lib/server/apiEndpoint';
import { buildPackStats } from '$lib/server/admin/packStats';
import type { RequestHandler } from './$types';

// Data for /admin/pack-stats (instant navigation). cardAdminEndpoint re-checks
// the card-admin role server-side on every fetch.
export const GET: RequestHandler = cardAdminEndpoint(() => buildPackStats());
