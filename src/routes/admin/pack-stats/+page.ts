import { instantLoad } from '$lib/instantLoad';
import type { buildPackStats } from '$lib/server/admin/packStats';
import type { PageLoad } from './$types';

// Type-only import above is erased at build time. The 'cardAdmin' guard is UX only —
// the /api/admin endpoint re-checks the role on every fetch.
export type PackStatsData = Awaited<ReturnType<typeof buildPackStats>>;

export const load: PageLoad = instantLoad<PackStatsData, 'packStats'>({
	key: 'packStats',
	guard: 'cardAdmin',
	url: '/api/admin/pack-stats'
});
