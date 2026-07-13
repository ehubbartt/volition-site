import { instantLoad } from '$lib/instantLoad';
import type { buildDinkDrops } from '$lib/server/admin/dinkDrops';
import type { PageLoad } from './$types';

// Type-only import above is erased at build time. The 'admin' guard is UX only —
// the /api/admin endpoint re-checks the role on every fetch.
export type DinkDropsData = Awaited<ReturnType<typeof buildDinkDrops>>;

export const load: PageLoad = instantLoad<DinkDropsData, 'dinkDrops'>({
	key: 'dinkDrops',
	guard: 'admin',
	url: ({ url }) =>
		'/api/admin/dink-drops' +
		(url.searchParams.get('show')
			? `?show=${encodeURIComponent(url.searchParams.get('show')!)}`
			: '')
});
