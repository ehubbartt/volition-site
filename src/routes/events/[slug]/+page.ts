import { instantLoad } from '$lib/instantLoad';
import type { EventDetailResult } from '$lib/server/eventDetail';
import type { PageLoad } from './$types';

// Type-only import above is erased at build time. Instant navigation: everything
// data-dependent (404, task-event redirect, live-team board redirect, the event
// itself) streams in from the API and only fresh responses steer (see swrRouted).
export const load: PageLoad = instantLoad<EventDetailResult, 'detail'>({
	key: 'detail',
	guard: 'onboarded',
	url: ({ params, url }) => {
		const qs = new URLSearchParams();
		if (url.searchParams.get('view') === 'teams') qs.set('view', 'teams');
		if (url.searchParams.get('demo') === '1') qs.set('demo', '1');
		return `/api/events/${params.slug}${qs.size ? `?${qs}` : ''}`;
	}
});
