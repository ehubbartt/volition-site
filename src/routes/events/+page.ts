import { redirect } from '@sveltejs/kit';
import type { EventSections } from '$lib/eventsList';
import { swr } from '$lib/swr';
import type { PageLoad } from './$types';

// UNIVERSAL load, no server load: navigating here never waits on the network.
// The auth gates run against the layout's already-loaded user; the list is a
// stale-while-revalidate pair — revisits show the last list instantly while a
// background refetch swaps in fresh data.
export const load: PageLoad = async ({ parent, fetch }) => {
	const { user } = await parent();
	if (!user) redirect(303, '/');
	if (!user.rsn || !user.clan_allegiance || !user.account_type) {
		redirect(303, '/onboarding');
	}

	return { sections: swr<EventSections>(fetch, '/api/events-list') };
};
