import { instantLoad } from '$lib/instantLoad';
import type { buildSubmissions } from '$lib/server/admin/submissions';
import type { PageLoad } from './$types';

// Type-only import above is erased at build time. The 'admin' guard is UX only —
// the /api/admin endpoint re-checks the role on every fetch.
export type SubmissionsData = Awaited<ReturnType<typeof buildSubmissions>>;

export const load: PageLoad = instantLoad<SubmissionsData, 'submissions'>({
	key: 'submissions',
	guard: 'admin',
	// Forward the queue's query params (?view / ?test / ?q) to the endpoint — the
	// load re-runs on every query change, so the view/tab links keep working.
	url: ({ url }) => {
		const qs = ['view', 'test', 'q']
			.map((k) => {
				const v = url.searchParams.get(k);
				return v ? `${k}=${encodeURIComponent(v)}` : null;
			})
			.filter(Boolean)
			.join('&');
		return `/api/admin/submissions${qs ? `?${qs}` : ''}`;
	}
});
