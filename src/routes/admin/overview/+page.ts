import { instantLoad } from '$lib/instantLoad';
import type { buildOverview } from '$lib/server/admin/overview';
import type { PageLoad } from './$types';

// Type-only import above is erased at build time. The 'admin' guard is UX only —
// the /api/admin endpoint re-checks the role on every fetch.
export type OverviewData = Awaited<ReturnType<typeof buildOverview>>;

export const load: PageLoad = instantLoad<OverviewData, 'overview'>({
	key: 'overview',
	guard: 'admin',
	url: '/api/admin/overview'
});
