import { redirect, error, fail } from '@sveltejs/kit';
import { db, fetchAllFiltered } from '$lib/server/db';
import { isAdmin } from '$lib/server/auth';
import {
	listRankOverrides,
	getRankOverride,
	saveRankOverride,
	clearRankOverride,
	hasEffect,
	CA_TIERS
} from '$lib/server/rankOverrides';
import { allGearItems, listGearGrants, grantGearItem, revokeGearGrant, listGearClaims } from '$lib/server/rankClaims';
import { checkAndSaveRank } from '$lib/server/rankCheck';
import { RANK_ORDER, RANK_LABEL } from '$lib/ranks';
import type { Actions, PageServerLoad } from './$types';

// Manual rank adjustments — the staff escape hatch for members the automated scoring
// can't score correctly, and the only place a rank is ever set by hand.
//
// Two tools on one page, because they answer the same question ("this member's real
// standing isn't what the data says"):
//   - ADJUSTMENTS (vs_rank_overrides) nudge the scoring inputs, or pin the rank outright.
//     The case that prompted it: group ironmen hold the Grandmaster combat-achievement
//     tier without completing every task, so WikiSync understates their CA component.
//   - ITEM GRANTS (vs_rank_item_claims, source='admin') credit gear the collection log
//     can't prove — four Zenyte shards dropped before the in-game log existed.
//
// Deliberately admin-only, deliberately NOT a members-facing channel: mass self-granting
// is exactly what the member claim queue's review step exists to prevent. Every write
// here is a POST under /admin/**, so hooks.server.ts records it in vs_audit_log with the
// full payload automatically, and both tables carry a mandatory reason plus who set it.

interface PickerPlayer {
	/** vs_users.id — null for a roster member with no site account. */
	id: string | null;
	rsn: string;
	discord_username: string | null;
	discord_id: string | null;
	account_type: string | null;
	adjusted: boolean;
}

const norm = (rsn: string) => rsn.trim().toLowerCase().replace(/[\s_]+/g, ' ');

// Everyone an admin might need to adjust: site members first (they can receive item
// grants, which need a vs_users id), then clan-roster members with no site account
// (adjustable, since overrides are keyed by RSN, but not grantable).
async function readPlayers(adjustedRsns: Set<string>): Promise<PickerPlayer[]> {
	const [{ data: siteRows }, { data: rosterRows }] = await Promise.all([
		fetchAllFiltered<{
			id: string;
			rsn: string | null;
			discord_username: string | null;
			discord_id: string | null;
			account_type: string | null;
		}>((f, t) =>
			db().from('vs_users').select('id, rsn, discord_username, discord_id, account_type').range(f, t)
		),
		fetchAllFiltered<{ rsn: string | null; discord_id: string | null }>((f, t) =>
			db().from('players').select('rsn, discord_id').range(f, t)
		)
	]);

	const site: PickerPlayer[] = siteRows
		.filter((u) => u.rsn)
		.map((u) => ({
			id: u.id,
			rsn: u.rsn!,
			discord_username: u.discord_username,
			discord_id: u.discord_id,
			account_type: u.account_type,
			adjusted: adjustedRsns.has(u.rsn!.toLowerCase())
		}));

	const seen = new Set(site.map((p) => norm(p.rsn)));
	const rosterOnly: PickerPlayer[] = [];
	for (const p of rosterRows) {
		if (!p.rsn) continue;
		const key = norm(p.rsn);
		if (seen.has(key)) continue;
		seen.add(key);
		rosterOnly.push({
			id: null,
			rsn: p.rsn,
			discord_username: null,
			discord_id: p.discord_id,
			account_type: null,
			adjusted: adjustedRsns.has(p.rsn.toLowerCase())
		});
	}

	const byName = (a: PickerPlayer, b: PickerPlayer) => a.rsn.localeCompare(b.rsn);
	return [...site.sort(byName), ...rosterOnly.sort(byName)];
}

export const load: PageServerLoad = async ({ locals, url }) => {
	if (!locals.user) throw redirect(303, '/');
	if (!isAdmin(locals.user)) throw error(403, 'Not allowed');

	const [overrides, grants] = await Promise.all([listRankOverrides(), listGearGrants()]);
	const adjustedRsns = new Set(overrides.filter(hasEffect).map((o) => o.rsn));
	const players = await readPlayers(adjustedRsns);

	// ?rsn= selects a player to work on (kept in the URL so a save can redirect back to
	// the same member and the page reloads their fresh state).
	const wanted = url.searchParams.get('rsn');
	const selected = wanted ? (players.find((p) => norm(p.rsn) === norm(wanted)) ?? null) : null;

	const [selectedOverride, selectedClaims] = await Promise.all([
		selected ? getRankOverride(selected.rsn) : Promise.resolve(null),
		selected?.id ? listGearClaims(selected.id) : Promise.resolve([])
	]);

	return {
		players,
		overrides,
		grants,
		selected,
		selectedOverride,
		// The member's own approved gear (claims + grants), so an admin can see what's
		// already credited before granting more.
		selectedApproved: selectedClaims.filter((c) => c.status === 'approved'),
		// The WHOLE gear table, not the claimable subset — an admin grant is the channel
		// for items that are trackable in principle but unprovable for this member.
		gearItems: allGearItems(),
		caTiers: CA_TIERS,
		rankOptions: RANK_ORDER.map((r) => ({ value: r, label: RANK_LABEL[r] }))
	};
};

// A saved adjustment only reaches the member's rank on their next rank check, so run one
// for them right away — the whole point of the page is to fix a wrong rank now. A failed
// re-check is reported, never fatal: the adjustment itself is already stored and the next
// scheduled check will pick it up.
async function recheckAfter(player: PickerPlayer): Promise<string | null> {
	const res = await checkAndSaveRank({
		userId: player.id,
		rsn: player.rsn,
		discordId: player.discord_id,
		accountType: player.account_type
	});
	if (!res.ok) return `Saved, but the rank re-check failed — ${res.error} It'll apply on the next check.`;
	const o = res.outcome;
	if (o.skippedSave) {
		return 'Saved, but the rank was not re-applied: TempleOSRS or WikiSync errored transiently, so scoring was skipped to avoid a wrong demotion. Re-check shortly.';
	}
	if (!o.saved) {
		return o.saveReason === 'no_player'
			? `Saved, and they now score as ${o.rank} — but no clan player record was found to write the rank to.`
			: `Saved, and they now score as ${o.rank} — but writing the clan rank failed. Try re-checking.`;
	}
	return null;
}

async function requirePlayer(rsn: string): Promise<PickerPlayer | null> {
	const players = await readPlayers(new Set());
	return players.find((p) => norm(p.rsn) === norm(rsn)) ?? null;
}

export const actions: Actions = {
	// Create or update one member's adjustments, then re-score them immediately.
	saveOverride: async ({ locals, request }) => {
		if (!locals.user || !isAdmin(locals.user)) throw error(403, 'Not allowed');
		const form = await request.formData();
		const rsn = (form.get('rsn') ?? '').toString();
		const player = await requirePlayer(rsn);
		if (!player) return fail(404, { saveError: 'Player not found.' });

		const num = (key: string) => {
			const raw = (form.get(key) ?? '').toString().trim();
			if (!raw) return 0;
			const n = Number(raw);
			return Number.isFinite(n) ? n : 0;
		};
		const optInt = (key: string) => {
			const raw = (form.get(key) ?? '').toString().trim();
			if (!raw) return null;
			const n = Number(raw);
			return Number.isFinite(n) ? Math.round(n) : null;
		};

		const res = await saveRankOverride(
			{
				rsn: player.rsn,
				userId: player.id,
				discordId: player.discord_id,
				rankOverride: (form.get('rank_override') ?? '').toString() || null,
				caTierOverride: (form.get('ca_tier_override') ?? '').toString() || null,
				gearPointsBonus: num('gear_points_bonus'),
				ehbBonus: num('ehb_bonus'),
				clogBonus: num('clog_bonus'),
				monthsBonus: num('months_bonus'),
				totalLevelOverride: optInt('total_level_override'),
				reason: (form.get('reason') ?? '').toString()
			},
			locals.user.id
		);
		if (!res.ok) return fail(400, { saveError: res.error });

		return { saveOk: true, rsn: player.rsn, warning: await recheckAfter(player) };
	},

	// Remove a member's adjustments entirely and re-score them on the raw data.
	clearOverride: async ({ locals, request }) => {
		if (!locals.user || !isAdmin(locals.user)) throw error(403, 'Not allowed');
		const form = await request.formData();
		const rsn = (form.get('rsn') ?? '').toString();
		if (!rsn) return fail(400, { saveError: 'Missing player.' });

		const res = await clearRankOverride(rsn);
		if (!res.ok) return fail(500, { saveError: res.error ?? 'Could not remove the adjustment.' });

		const player = await requirePlayer(rsn);
		return { clearOk: true, rsn, warning: player ? await recheckAfter(player) : null };
	},

	// Credit a member with a gear item they own but can't prove.
	grantItem: async ({ locals, request }) => {
		if (!locals.user || !isAdmin(locals.user)) throw error(403, 'Not allowed');
		const form = await request.formData();
		const rsn = (form.get('rsn') ?? '').toString();
		const player = await requirePlayer(rsn);
		if (!player) return fail(404, { grantError: 'Player not found.' });
		// Grants hang off vs_rank_item_claims.user_id, so they need a site account. An
		// input adjustment (gear points) is the fallback for a roster-only member.
		if (!player.id) {
			return fail(400, {
				grantError: `${player.rsn} has no site account, so an item can't be attached to them. Use a gear-points adjustment instead.`
			});
		}

		const res = await grantGearItem(
			player.id,
			(form.get('item_name') ?? '').toString(),
			Math.floor(Number(form.get('quantity') ?? 1)) || 1,
			(form.get('reason') ?? '').toString(),
			locals.user.id
		);
		if (!res.ok) return fail(400, { grantError: res.error });

		return { grantOk: true, rsn: player.rsn, warning: await recheckAfter(player) };
	},

	// Take a grant back. The member is re-scored so the points come off now, not on their
	// next check — a mistaken grant shouldn't linger on the leaderboard.
	revokeGrant: async ({ locals, request }) => {
		if (!locals.user || !isAdmin(locals.user)) throw error(403, 'Not allowed');
		const form = await request.formData();
		const id = Math.floor(Number(form.get('id')));
		if (!Number.isFinite(id)) return fail(400, { grantError: 'Unknown grant.' });

		const res = await revokeGearGrant(id);
		if (!res.ok) return fail(500, { grantError: res.error ?? 'Could not revoke the grant.' });

		const rsn = (form.get('rsn') ?? '').toString();
		const player = rsn ? await requirePlayer(rsn) : null;
		return { revokeOk: true, rsn, warning: player ? await recheckAfter(player) : null };
	}
};
