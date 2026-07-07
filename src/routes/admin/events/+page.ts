import { instantLoad } from '$lib/instantLoad';
import type { buildEvents } from '$lib/server/admin/events';
import type { PageLoad } from './$types';

// Type-only import above is erased at build time. The 'admin' guard is UX only —
// the /api/admin endpoint re-checks the role on every fetch.
export type EventsData = Awaited<ReturnType<typeof buildEvents>>;

export const load: PageLoad = instantLoad<EventsData, 'events'>({
	key: 'events',
	guard: 'admin',
	url: '/api/admin/events'
});
