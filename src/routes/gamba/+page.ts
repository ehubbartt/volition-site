import { instantLoad } from '$lib/instantLoad';
import type { buildGambaData } from '$lib/server/gambaPage';
import type { PageLoad } from './$types';

// Type-only import above is erased at build time — the page just gets accurate
// types for the streamed payload. Instant navigation: see docs/PAGES.md.
export type GambaData = Awaited<ReturnType<typeof buildGambaData>>;

export const load: PageLoad = instantLoad<GambaData, 'gamba'>({
	key: 'gamba',
	guard: 'onboarded',
	url: '/api/gamba'
});
