import { adminEndpoint } from '$lib/server/apiEndpoint';
import { buildSubmissions } from '$lib/server/admin/submissions';
import type { RequestHandler } from './$types';

// Data for /admin/submissions (instant navigation). adminEndpoint re-checks the
// admin role server-side on every fetch.
export const GET: RequestHandler = adminEndpoint((_user, event) => {
	const sp = event.url.searchParams;
	const view = sp.get('view') === 'reviewed' ? 'reviewed' : 'pending';
	// Test view: admin preview-run submissions (vs_submissions.test), kept out of the
	// live queue. Default (live) hides them; ?test=1 shows ONLY them.
	const test = sp.get('test') === '1';
	// Reviewed-history search (server-side, so it reaches submissions older than the
	// recent window the list loads by default).
	const search = sp.get('q')?.trim() ?? '';
	return buildSubmissions({ view, test, search });
});
