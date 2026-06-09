import { redirect, error } from '@sveltejs/kit';
import { isCardTester } from '$lib/server/auth';
import { findUserBySlug } from '$lib/server/users';
import { loadCardProfile } from '$lib/server/cardProfile';
import type { PageServerLoad } from './$types';

// Public (card-tester gated) read-only view of any player's card profile —
// identity, collection, owned packs, VP, wallet, and stats. Addressed by RSN
// (/u/Zezima). Mirrors /me without the self-only edit form / sign-out. Gated to
// card testers while the card game is in progress.
export const load: PageServerLoad = async ({ locals, params }) => {
	if (!locals.user) throw redirect(303, '/');
	if (!isCardTester(locals.user)) throw error(403, 'Not allowed');

	const target = await findUserBySlug(params.rsn);
	if (!target) throw error(404, 'Player not found');

	const profile = await loadCardProfile(target);

	return {
		profileUser: target,
		isSelf: target.id === locals.user.id,
		vp_balance: profile.vp_balance,
		wallet: profile.wallet,
		collection: profile.collection,
		collectionOwned: profile.collectionOwned,
		collectionTotal: profile.collectionTotal,
		stats: profile.stats,
		packs: profile.packs
	};
};
