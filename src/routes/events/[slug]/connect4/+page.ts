import { instantLoad } from '$lib/instantLoad';
import type { Connect4PageResult } from '$lib/server/connect4Page';
import type { PageLoad } from './$types';

// Type-only import above is erased at build time (see docs/PAGES.md).
export const load: PageLoad = instantLoad<Connect4PageResult, 'connect4'>({
	key: 'connect4',
	guard: 'onboarded',
	url: ({ params }) => `/api/connect4/${params.slug}`
});
