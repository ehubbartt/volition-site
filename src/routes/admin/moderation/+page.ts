import { instantLoad } from '$lib/instantLoad';
import type { buildModeration } from '$lib/server/admin/moderation';
import type { PageLoad } from './$types';

// Type-only import above is erased at build time. The 'admin' guard is UX only —
// the /api/admin endpoint re-checks the role on every fetch.
export type ModerationData = Awaited<ReturnType<typeof buildModeration>>;

export const load: PageLoad = instantLoad<ModerationData, 'moderation'>({
	key: 'moderation',
	guard: 'admin',
	url: '/api/admin/moderation'
});
