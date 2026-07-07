import { redirect } from '@sveltejs/kit';
import type { EventDetailResult } from '$lib/server/eventDetail';
import { swr } from '$lib/swr';
import type { PageLoad } from './$types';

// Type-only import above is erased at build time — no server code reaches the
// client, the page just gets accurate types for the streamed payload.

// UNIVERSAL load, no server load: navigating to an event never waits on the
// network. Auth gates + the static bingo-slug redirect run against what the
// client already knows; everything data-dependent (404, task-event redirect,
// live-team board redirect, the event itself) streams in from the API and the
// page acts on it when it lands.
export const load: PageLoad = async ({ parent, fetch, params, url }) => {
	const { user } = await parent();
	if (!user) redirect(303, '/');
	if (!user.rsn || !user.clan_allegiance || !user.account_type) {
		redirect(303, '/onboarding');
	}
	const qs = new URLSearchParams();
	if (url.searchParams.get('view') === 'teams') qs.set('view', 'teams');
	if (url.searchParams.get('demo') === '1') qs.set('demo', '1');
	const query = qs.size ? `?${qs}` : '';

	// Stale-while-revalidate: revisiting an event seeds from the last payload this
	// browser saw for it, while the background refetch swaps in fresh data.
	return { detail: swr<EventDetailResult>(fetch, `/api/events/${params.slug}${query}`) };
};
