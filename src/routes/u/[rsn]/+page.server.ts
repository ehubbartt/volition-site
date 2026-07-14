import { redirect, error } from '@sveltejs/kit';
import { findUserBySlug } from '$lib/server/users';
import { loadCardProfile } from '$lib/server/cardProfile';
import { loadRankBreakdown } from '$lib/server/meData';
import { getPlayerRank } from '$lib/server/playerStats';
import type { PageServerLoad } from './$types';

// Public read-only view of any player's card profile — identity, rank, collection,
// owned packs, VP, wallet, and stats. Addressed by RSN (/u/Zezima). Mirrors /me
// without the self-only edit form / sign-out. Open to any logged-in member.
export const load: PageServerLoad = async ({ locals, params }) => {
	if (!locals.user) throw redirect(303, '/');

	const target = await findUserBySlug(params.rsn);
	if (!target) throw error(404, 'Player not found');

	const [profile, currentRank, rank] = await Promise.all([
		loadCardProfile(target),
		getPlayerRank(target.discord_id, target.rsn),
		loadRankBreakdown(target.rsn)
	]);

	return {
		profileUser: target,
		isSelf: target.id === locals.user.id,
		currentRank,
		// Public page: render the breakdown only — a lookup failure is logged
		// server-side by loadRankBreakdown but never shown to other members.
		rankBreakdown: rank.breakdown,
		vp_balance: profile.vp_balance,
		wallet: profile.wallet,
		collection: profile.collection,
		collectionOwned: profile.collectionOwned,
		collectionTotal: profile.collectionTotal,
		stats: profile.stats,
		crateStats: profile.crateStats,
		packs: profile.packs
	};
};
