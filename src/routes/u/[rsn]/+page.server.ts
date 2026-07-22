import { redirect, error, fail } from '@sveltejs/kit';
import { findUserBySlug } from '$lib/server/users';
import { isAdmin } from '$lib/server/auth';
import { loadCardProfile } from '$lib/server/cardProfile';
import { loadRankBreakdown } from '$lib/server/meData';
import { getPlayerRank } from '$lib/server/playerStats';
import { checkAndSaveRank } from '$lib/server/rankCheck';
import type { Actions, PageServerLoad } from './$types';

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
		// Admins get a "Re-check rank" button on any profile (see the recheck action).
		canRecheck: isAdmin(locals.user),
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

export const actions: Actions = {
	// Admin-only: re-run this member's live rank check on demand — the same path as their
	// own /me "Check my rank" (fetch WOM/Temple/WikiSync + approved gear claims, cache the
	// breakdown, and save players.rank only when both stats sources responded). The page
	// load re-runs after this action, so the rank panel reflects the fresh result.
	recheck: async ({ locals, params }) => {
		if (!locals.user || !isAdmin(locals.user)) throw error(403, 'Not allowed');

		const target = await findUserBySlug(params.rsn);
		if (!target) return fail(404, { recheckError: 'Player not found.' });
		if (!target.rsn) return fail(400, { recheckError: 'This member has no RSN set.' });

		const result = await checkAndSaveRank({
			userId: target.id,
			rsn: target.rsn,
			discordId: target.discord_id,
			accountType: target.account_type
		});
		if (!result.ok) return fail(502, { recheckError: result.error });

		const o = result.outcome;
		return {
			recheckOk: true,
			recheckRank: o.rank,
			recheckSaved: o.saved,
			recheckRankedUp: o.rankedUp,
			recheckPrevRank: o.prevRank,
			recheckNote: o.skippedSave
				? 'Computed from partial data — Temple or WikiSync was unavailable, so the clan rank was NOT changed (avoids a wrong demotion). Try again shortly.'
				: o.saved
					? null
					: o.saveReason === 'no_player'
						? 'Breakdown updated, but no clan player record was found to save the rank to.'
						: 'Breakdown updated, but saving the clan rank failed — try again.'
		};
	}
};
