import { redirect } from '@sveltejs/kit';
import type { BingoDetail } from '$lib/server/bingoPage';
import { swr } from '$lib/swr';
import type { PageLoad } from './$types';

// Type-only import above is erased at build time — the page just gets accurate
// types for the streamed payload.

// UNIVERSAL load, no server load: navigating to a bingo board never waits on
// the network. Revisits render the last-seen board instantly (client cache)
// while a background refetch swaps in fresh tile/leaderboard state.
export const load: PageLoad = async ({ parent, fetch, params }) => {
	const { user } = await parent();
	if (!user) redirect(303, '/');
	if (!user.rsn || !user.clan_allegiance || !user.account_type) {
		redirect(303, '/onboarding');
	}

	return { detail: swr<BingoDetail>(fetch, `/api/bingo/${params.slug}`) };
};
