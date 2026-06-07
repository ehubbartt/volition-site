import { redirect, error } from '@sveltejs/kit';
import { isAdmin, isCardTester } from '$lib/server/auth';
import { BINGO_EVENT_SLUG } from '$lib/bingo/config';
import type { PageServerLoad } from './$types';

// General admin hub. Reachable by anyone with EITHER permission; the page itself
// only shows the tools each role can use (admin → events/bingo, card tester →
// cards/pack tester). The two permissions are independent (see auth.ts).
export const load: PageServerLoad = ({ locals }) => {
	if (!locals.user) throw redirect(303, '/');
	const admin = isAdmin(locals.user);
	const cardTester = isCardTester(locals.user);
	if (!admin && !cardTester) throw error(403, 'Not allowed');
	return { admin, cardTester, bingoSlug: BINGO_EVENT_SLUG };
};
