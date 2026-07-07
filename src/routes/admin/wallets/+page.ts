import { instantLoad } from '$lib/instantLoad';
import type { buildWallets } from '$lib/server/admin/wallets';
import type { PageLoad } from './$types';

// Type-only import above is erased at build time. The 'admin' guard is UX only —
// the /api/admin endpoint re-checks the role on every fetch.
export type WalletsData = Awaited<ReturnType<typeof buildWallets>>;

export const load: PageLoad = instantLoad<WalletsData, 'wallets'>({
	key: 'wallets',
	guard: 'admin',
	url: '/api/admin/wallets'
});
