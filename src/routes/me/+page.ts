import { redirect } from '@sveltejs/kit';
import type { buildMeData } from '$lib/server/meData';
import type { PageLoad } from './$types';

// Type-only import above is erased at build time — the page just gets accurate
// types for the streamed payload.
export type MeData = Awaited<ReturnType<typeof buildMeData>>;

// UNIVERSAL load, no server load: navigating to /me never waits on the network.
export const load: PageLoad = async ({ parent, fetch }) => {
	const { user } = await parent();
	if (!user) redirect(303, '/');

	const me: Promise<MeData | null> = fetch('/api/me')
		.then((r) => {
			if (!r.ok) throw new Error(`me ${r.status}`);
			return r.json() as Promise<MeData>;
		})
		.catch(() => null);

	return { me };
};
