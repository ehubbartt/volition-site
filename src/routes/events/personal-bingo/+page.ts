import { instantLoad } from '$lib/instantLoad';
import type { buildPersonalBoardData } from '$lib/server/personalBoardPage';
import type { PageLoad } from './$types';

// Type-only import above is erased at build time — the page just gets accurate
// types for the streamed payload. Instant navigation: see docs/ARCHITECTURE.md.
export type PersonalBoardData = Awaited<ReturnType<typeof buildPersonalBoardData>>;

export const load: PageLoad = instantLoad<PersonalBoardData, 'pb'>({
	key: 'pb',
	guard: 'member',
	url: '/api/personal-board'
});
