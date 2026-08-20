import { redirect, error, fail } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { findUserBySlug } from '$lib/server/users';
import { isAdmin } from '$lib/server/auth';
import { loadCardProfile } from '$lib/server/cardProfile';
import { loadRankBreakdown } from '$lib/server/meData';
import { getPlayerRank } from '$lib/server/playerStats';
import { checkAndSaveRank } from '$lib/server/rankCheck';
import {
	getRankOverride,
	patchRankOverride,
	clearRankOverride,
	CA_TIERS,
	type RankOverridePatch
} from '$lib/server/rankOverrides';
import { listGearClaims, grantGearItem, revokeGearGrant, itemQuantityCaps } from '$lib/server/rankClaims';
import { RANK_ORDER, RANK_LABEL } from '$lib/ranks';
import type { ProfileUser } from '$lib/server/users';
import type { Actions, PageServerLoad } from './$types';

// Public read-only view of any player's card profile — identity, rank, collection,
// owned packs, VP, wallet, and stats. Addressed by RSN (/u/Zezima). Mirrors /me
// without the self-only edit form / sign-out. Open to any logged-in member.
export const load: PageServerLoad = async ({ locals, params }) => {
	if (!locals.user) throw redirect(303, '/');

	const target = await findUserBySlug(params.rsn);
	if (!target) throw error(404, 'Player not found');

	const admin = isAdmin(locals.user);
	const [profile, currentRank, rank, override, claims] = await Promise.all([
		loadCardProfile(target),
		getPlayerRank(target.discord_id, target.rsn),
		loadRankBreakdown(target.rsn),
		// The staff adjustments an admin edits in place on this page (docs/RANKS.md).
		// Members never see these controls, and never see the values either.
		admin ? getRankOverride(target.rsn) : Promise.resolve(null),
		admin ? listGearClaims(target.id) : Promise.resolve([])
	]);

	// Who last adjusted them, for the standing note on the panel — an admin looking at an
	// adjusted member shouldn't have to leave for the record to find out who did it.
	const setBy = override?.updated_by ? await resolveAdminName(override.updated_by) : null;

	return {
		profileUser: target,
		isSelf: target.id === locals.user.id,
		// Admins get a "Re-check rank" button on any profile (see the recheck action).
		canRecheck: admin,
		// Admin-only: everything the in-place rank/gear editors need. Null for everyone
		// else, which is also what switches the editing affordances off in RankPanel.
		adminEdit: admin
			? {
					override,
					setBy,
					caTiers: CA_TIERS,
					rankOptions: RANK_ORDER.map((r) => ({ value: r as string, label: RANK_LABEL[r] })),
					// Manual gear already credited to them, so a gear tile can show what's
					// granted and offer to take it back.
					granted: claims
						.filter((c) => c.status === 'approved')
						.map((c) => ({
							id: c.id,
							item_name: c.item_name,
							quantity: c.quantity,
							source: c.source
						})),
					// Items the gear table wants more than one of, so the count field can cap
					// itself and say so — the four-Zenyte-shards case.
					quantityCaps: itemQuantityCaps()
				}
			: null,
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
				? 'Computed from partial data — Temple or WikiSync errored transiently, so the clan rank was NOT changed (avoids a wrong demotion). Try again shortly.'
				: o.saved && (!o.templeAvailable || !o.wikisyncAvailable)
					? `Ranked on available data — ${[!o.templeAvailable ? 'TempleOSRS' : null, !o.wikisyncAvailable ? 'WikiSync' : null].filter(Boolean).join(' and ')} has no record for this member, so gear/clog/CA scored 0. They'll rank higher once they sync.`
					: o.saved
						? null
						: o.saveReason === 'no_player'
							? 'Breakdown updated, but no clan player record was found to save the rank to.'
							: 'Breakdown updated, but saving the clan rank failed — try again.'
		};
	},

	// --- In-place staff adjustments (docs/RANKS.md) ---------------------------
	// An admin edits a member's scoring where they read it: click a score bar to adjust
	// that one component, the rank badge to pin the rank, a gear tile to credit the item.
	// Each write re-scores the member immediately, so the panel behind the editor shows
	// the result rather than the admin having to remember to re-check.

	// One component's adjustment. `field` names which one, so each editor owns exactly the
	// value it displays and can't clobber the others (patchRankOverride merges).
	adjust: async ({ locals, params, request }) => {
		if (!locals.user || !isAdmin(locals.user)) throw error(403, 'Not allowed');
		const target = await requireTarget(params.rsn);
		if (!target) return fail(404, { adjustError: 'Player not found.' });

		const form = await request.formData();
		const field = (form.get('field') ?? '').toString();
		const raw = (form.get('value') ?? '').toString().trim();
		const reason = (form.get('reason') ?? '').toString();

		// An empty box means "no adjustment": 0 for the additive nudges, null for the two
		// that replace a value outright.
		const num = () => {
			const n = Number(raw);
			return raw && Number.isFinite(n) ? n : 0;
		};
		const optInt = () => {
			const n = Number(raw);
			return raw && Number.isFinite(n) ? Math.round(n) : null;
		};

		// The component key each score bar posts → the one field it owns. This is also the
		// whitelist: anything not named here is rejected rather than silently ignored, so a
		// bar with no legitimate adjustment (Volition TCG, read from our own card tables)
		// can't be adjusted by hand-crafting a request.
		const PATCH_BY_FIELD: Record<string, () => RankOverridePatch> = {
			ca: () => ({ caTierOverride: raw || null }),
			gear: () => ({ gearPointsBonus: num() }),
			ehb: () => ({ ehbBonus: num() }),
			clog: () => ({ clogBonus: num() }),
			time: () => ({ monthsBonus: num() }),
			level: () => ({ totalLevelOverride: optInt() })
		};
		const build = PATCH_BY_FIELD[field];
		if (!build) return fail(400, { adjustError: `“${field}” isn't an adjustable component.` });

		// The "a reason is required unless the row already has one" rule lives in
		// patchRankOverride, which is the thing that knows the merged row.
		const res = await patchRankOverride(
			{ rsn: target.rsn, userId: target.id, discordId: target.discord_id },
			build(),
			reason,
			locals.user.id
		);
		if (!res.ok) return fail(400, { adjustError: res.error });
		return { adjustOk: true, adjustField: field, ...(await rescore(target)) };
	},

	// The hard rank pin (or removing it — an empty value clears).
	pinRank: async ({ locals, params, request }) => {
		if (!locals.user || !isAdmin(locals.user)) throw error(403, 'Not allowed');
		const target = await requireTarget(params.rsn);
		if (!target) return fail(404, { adjustError: 'Player not found.' });

		const form = await request.formData();
		const value = (form.get('value') ?? '').toString().trim() || null;
		const reason = (form.get('reason') ?? '').toString();

		const res = await patchRankOverride(
			{ rsn: target.rsn, userId: target.id, discordId: target.discord_id },
			{ rankOverride: value },
			reason,
			locals.user.id
		);
		if (!res.ok) return fail(400, { adjustError: res.error });
		return { adjustOk: true, adjustField: 'rank', ...(await rescore(target)) };
	},

	// Remove every adjustment on this member at once and re-score them raw.
	clearAdjustments: async ({ locals, params }) => {
		if (!locals.user || !isAdmin(locals.user)) throw error(403, 'Not allowed');
		const target = await requireTarget(params.rsn);
		if (!target) return fail(404, { adjustError: 'Player not found.' });

		const res = await clearRankOverride(target.rsn);
		if (!res.ok) return fail(500, { adjustError: res.error ?? 'Could not remove the adjustments.' });
		return { adjustOk: true, adjustField: 'all', ...(await rescore(target)) };
	},

	// Credit this member with a gear item the collection log can't prove for them.
	grantItem: async ({ locals, params, request }) => {
		if (!locals.user || !isAdmin(locals.user)) throw error(403, 'Not allowed');
		const target = await requireTarget(params.rsn);
		if (!target) return fail(404, { grantError: 'Player not found.' });

		const form = await request.formData();
		const res = await grantGearItem(
			target.id,
			(form.get('item_name') ?? '').toString(),
			Math.floor(Number(form.get('quantity') ?? 1)) || 1,
			(form.get('reason') ?? '').toString(),
			locals.user.id
		);
		if (!res.ok) return fail(400, { grantError: res.error });
		return { grantOk: true, ...(await rescore(target)) };
	},

	revokeGrant: async ({ locals, params, request }) => {
		if (!locals.user || !isAdmin(locals.user)) throw error(403, 'Not allowed');
		const target = await requireTarget(params.rsn);
		if (!target) return fail(404, { grantError: 'Player not found.' });

		const form = await request.formData();
		const id = Math.floor(Number(form.get('id')));
		if (!Number.isFinite(id)) return fail(400, { grantError: 'Unknown grant.' });

		const res = await revokeGearGrant(id);
		if (!res.ok) return fail(500, { grantError: res.error ?? 'Could not revoke the grant.' });
		return { grantOk: true, ...(await rescore(target)) };
	}
};

/** An admin's display name for "adjusted by": their RSN, or their Discord name if unset. */
async function resolveAdminName(userId: string): Promise<string | null> {
	const { data } = await db().from('vs_users').select('rsn, discord_username').eq('id', userId).maybeSingle();
	const u = data as { rsn: string | null; discord_username: string | null } | null;
	return u ? u.rsn || u.discord_username : null;
}

/** The profile's member, or null — every admin action needs an id AND an RSN to score by. */
async function requireTarget(slug: string): Promise<(ProfileUser & { rsn: string }) | null> {
	const target = await findUserBySlug(slug);
	return target?.rsn ? (target as ProfileUser & { rsn: string }) : null;
}

// Re-score right after an edit so the panel behind the editor shows the new result. A
// degraded fetch is reported as a warning, never fatal: the adjustment is already stored
// and the member's next check will pick it up.
async function rescore(target: ProfileUser & { rsn: string }): Promise<{ adjustWarning: string | null }> {
	const res = await checkAndSaveRank({
		userId: target.id,
		rsn: target.rsn,
		discordId: target.discord_id,
		accountType: target.account_type
	});
	if (!res.ok) return { adjustWarning: `Saved, but the re-check failed — ${res.error} It'll apply on the next check.` };
	if (res.outcome.skippedSave) {
		return {
			adjustWarning:
				'Saved, but the rank was not re-applied: TempleOSRS or WikiSync errored transiently, so scoring was skipped to avoid a wrong demotion. Re-check shortly.'
		};
	}
	if (!res.outcome.saved) {
		return {
			adjustWarning:
				res.outcome.saveReason === 'no_player'
					? `Saved, and they now score as ${res.outcome.rank} — but no clan player record was found to write the rank to.`
					: `Saved, and they now score as ${res.outcome.rank} — but writing the clan rank failed.`
		};
	}
	return { adjustWarning: null };
}
