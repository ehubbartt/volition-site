import { redirect } from '@sveltejs/kit';
import type { EventTaskDetail } from '$lib/server/eventTaskPage';
import { swr } from '$lib/swr';
import type { PageLoad } from './$types';

// Type-only import above is erased at build time — the page just gets accurate
// types for the streamed payload.

// UNIVERSAL load, no server load: navigating to a task event never waits on the
// network. Revisits render the last-seen event instantly (client cache); the
// data-dependent outcomes (404, bespoke-page redirects) arrive in the payload.
export const load: PageLoad = async ({ parent, fetch, params }) => {
	const { user } = await parent();
	if (!user) redirect(303, '/');
	if (!user.rsn || !user.clan_allegiance || !user.account_type) {
		redirect(303, '/onboarding');
	}

	return { detail: swr<EventTaskDetail>(fetch, `/api/event/${params.slug}`) };
};
