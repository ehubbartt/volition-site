import { instantLoad } from '$lib/instantLoad';
import type { EventSections } from '$lib/eventsList';
import type { PageLoad } from './$types';

// Instant navigation: see docs/ARCHITECTURE.md.
export const load: PageLoad = instantLoad<EventSections, 'sections'>({
	key: 'sections',
	guard: 'onboarded',
	url: '/api/events-list'
});
