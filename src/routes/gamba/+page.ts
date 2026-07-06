import { redirect } from '@sveltejs/kit';
import type { buildGambaData } from '$lib/server/gambaPage';
import { swr } from '$lib/swr';
import type { PageLoad } from './$types';

// Type-only import above is erased at build time, so no server code reaches the
// client — the page just gets accurate types for the streamed payload.
export type GambaData = Awaited<ReturnType<typeof buildGambaData>>;

// UNIVERSAL load, no server load: navigating to /gamba never waits on the
// network. Auth gates run against the layout's already-loaded user; the page
// renders skeletons immediately and the data streams in from /api/gamba.
export const load: PageLoad = async ({ parent, fetch }) => {
	const { user } = await parent();
	if (!user) redirect(303, '/');
	if (!user.rsn || !user.clan_allegiance || !user.account_type) {
		redirect(303, '/onboarding');
	}

	// Stale-while-revalidate: revisits render the last-seen store/balances
	// instantly while a background refetch swaps in fresh data.
	return { gamba: swr<GambaData>(fetch, '/api/gamba') };
};
