import { redirect, error } from '@sveltejs/kit';
import { isAdmin, isCardTester, isSuperAdmin } from '$lib/server/auth';
import { BINGO_EVENT_SLUG } from '$lib/bingo/config';
import { DUO_WOLF_EVENT_SLUG } from '$lib/server/duoWolfTiles';
import type { PageServerLoad } from './$types';

// General admin hub. Reachable by anyone with ANY admin permission; the page itself
// only shows the tools each role can use (admin → events/bingo/dashboard, card tester →
// cards/pack tester, super-admin → table + bot-config editors). The permissions are
// independent (see auth.ts).
export const load: PageServerLoad = ({ locals }) => {
	if (!locals.user) throw redirect(303, '/');
	const admin = isAdmin(locals.user);
	const cardTester = isCardTester(locals.user);
	const superAdmin = isSuperAdmin(locals.user);
	if (!admin && !cardTester && !superAdmin) throw error(403, 'Not allowed');
	return { admin, cardTester, superAdmin, bingoSlug: BINGO_EVENT_SLUG, duoSlug: DUO_WOLF_EVENT_SLUG };
};
