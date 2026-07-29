import { instantLoad } from '$lib/instantLoad';
import type { BattleshipPageResult } from '$lib/server/battleshipPage';
import type { PageLoad } from './$types';

// Type-only import above is erased at build time (see docs/PAGES.md).
export const load: PageLoad = instantLoad<BattleshipPageResult, 'battleship'>({
	key: 'battleship',
	guard: 'onboarded',
	url: ({ params }) => `/api/battleship/${params.slug}`
});
