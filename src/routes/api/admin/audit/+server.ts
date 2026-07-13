import { adminEndpoint } from '$lib/server/apiEndpoint';
import { buildAudit } from '$lib/server/admin/audit';
import type { RequestHandler } from './$types';

// Data for /admin/audit (instant navigation). Admin-only (the audit log is
// sensitive — card testers don't see it); adminEndpoint re-checks the role
// server-side on every fetch.
export const GET: RequestHandler = adminEndpoint((_user, event) =>
	buildAudit(event.url.searchParams.get('before'))
);
