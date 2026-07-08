import { instantLoad } from '$lib/instantLoad';
import type { buildMeData } from '$lib/server/meData';
import type { PageLoad } from './$types';

// Type-only import above is erased at build time — the page just gets accurate
// types for the streamed payload. Instant navigation: see docs/PAGES.md.
export type MeData = Awaited<ReturnType<typeof buildMeData>>;

export const load: PageLoad = instantLoad<MeData, 'me'>({
	key: 'me',
	guard: 'member',
	url: '/api/me'
});
