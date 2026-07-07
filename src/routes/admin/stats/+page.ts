import { instantLoad } from '$lib/instantLoad';
import type { buildAdminStats } from '$lib/server/admin/stats';
import type { PageLoad } from './$types';

// Type-only import above is erased at build time. The 'admin' guard is UX only —
// the /api/admin endpoint re-checks the role on every fetch.
export type AdminStats = Awaited<ReturnType<typeof buildAdminStats>>;

export const load: PageLoad = instantLoad<AdminStats, 'stats'>({
	key: 'stats',
	guard: 'admin',
	url: '/api/admin/stats'
});
