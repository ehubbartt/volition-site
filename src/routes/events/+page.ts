import { redirect } from '@sveltejs/kit';
import { EMPTY_SECTIONS, type EventSections } from '$lib/eventsList';
import type { PageLoad } from './$types';

// UNIVERSAL load, no server load: navigating here never waits on the network.
// The auth gates run against the layout's already-loaded user, the page renders
// its skeletons immediately, and the list streams in from /api/events-list.
export const load: PageLoad = async ({ parent, fetch }) => {
	const { user } = await parent();
	if (!user) redirect(303, '/');
	if (!user.rsn || !user.clan_allegiance || !user.account_type) {
		redirect(303, '/onboarding');
	}

	const sections: Promise<EventSections> = fetch('/api/events-list')
		.then((r) => {
			if (!r.ok) throw new Error(`events-list ${r.status}`);
			return r.json() as Promise<EventSections>;
		})
		.catch(() => EMPTY_SECTIONS);

	return { sections };
};
