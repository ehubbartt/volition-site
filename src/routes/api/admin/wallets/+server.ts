import { adminEndpoint } from '$lib/server/apiEndpoint';
import { buildWallets } from '$lib/server/admin/wallets';
import type { RequestHandler } from './$types';

// Data for /admin/wallets (instant navigation). adminEndpoint re-checks the
// admin role server-side on every fetch.
export const GET: RequestHandler = adminEndpoint(() => buildWallets());
