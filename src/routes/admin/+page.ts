import { error, redirect } from '@sveltejs/kit';
import { BINGO_EVENT_SLUG } from '$lib/bingo/config';
import type { PageLoad } from './$types';

// General admin hub. Reachable by anyone with ANY admin permission; the page only
// shows the tools each role can use. Universal load, zero network: the role flags
// come from the layout (UX only — every admin API endpoint re-checks server-side).
export const load: PageLoad = async ({ parent }) => {
	const { user, isAdmin, isCardTester, isSuperAdmin } = await parent();
	if (!user) redirect(303, '/');
	if (!isAdmin && !isCardTester && !isSuperAdmin) error(403, 'Not allowed');
	return {
		admin: isAdmin,
		cardTester: isCardTester,
		superAdmin: isSuperAdmin,
		bingoSlug: BINGO_EVENT_SLUG
	};
};
