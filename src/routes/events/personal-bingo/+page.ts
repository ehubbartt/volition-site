import { redirect } from '@sveltejs/kit';
import type { buildPersonalBoardData } from '$lib/server/personalBoardPage';
import { swr } from '$lib/swr';
import type { PageLoad } from './$types';

// Type-only import above is erased at build time — the page just gets accurate
// types for the streamed payload.
export type PersonalBoardData = Awaited<ReturnType<typeof buildPersonalBoardData>>;

// UNIVERSAL load, no server load: navigating to your personal board never waits
// on the network. Revisits render the last-seen board instantly (client cache)
// while a background refetch swaps in fresh completion state.
export const load: PageLoad = async ({ parent, fetch }) => {
	const { user } = await parent();
	if (!user) redirect(303, '/');

	return { pb: swr<PersonalBoardData>(fetch, '/api/personal-board') };
};
