import { instantLoad } from '$lib/instantLoad';
import type { EventTaskDetail } from '$lib/server/eventTaskPage';
import type { PageLoad } from './$types';

// Type-only import above is erased at build time. Instant navigation: the
// data-dependent outcomes (404, bespoke-page redirects) arrive in the payload
// and only fresh responses steer (see swrRouted in the page).
export const load: PageLoad = instantLoad<EventTaskDetail, 'detail'>({
	key: 'detail',
	guard: 'onboarded',
	url: ({ params }) => `/api/event/${params.slug}`
});
