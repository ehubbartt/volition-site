// SERVER-ONLY: manual rank adjustments (vs_rank_overrides, db/scripts/
// rank_manual_adjustments.sql) — the staff escape hatch for members the automated
// scoring can't score correctly, and the only way a rank is ever set by hand.
//
// The motivating case: group ironmen hold the Grandmaster combat-achievement tier
// without completing every task, so the WikiSync task list understates their CA
// component and no amount of code can tell that apart from someone who simply hasn't
// done the tasks. An admin sets `caTierOverride = 'grandmaster'` on /admin/ranks/
// adjustments and the component scores correctly from then on.
//
// TWO LEVELS, deliberately ordered weakest-first:
//   - INPUT adjustments (ca tier, gear/ehb/clog/months nudges, total level) feed the
//     normal formula, so caps, curves and thresholds all still apply and the member
//     keeps climbing on their own from the adjusted baseline. Prefer these.
//   - `rankOverride` is a HARD PIN: the composite is still computed and cached (so the
//     /me breakdown stays honest about the underlying numbers) but the rank the member
//     is given is the pinned one. A blunt instrument; use when nothing else fits.
//
// Applied at FETCH time, exactly like approved gear claims: the adjusted inputs are what
// gets cached in vs_rank_sim, so every downstream reader (the /me breakdown, the home
// rank spread, the simulator) reflects them with no extra plumbing. Nothing is rewritten
// retroactively — an adjustment lands on the member's next rank check, which the admin
// page runs for them on save.

import { db } from './db';
import { caPointsForTier, CA_TIER_ORDER, type RankInputs } from './rankScoring';
import { RANK_ORDER, type RankValue } from '$lib/ranks';

export interface RankOverride {
	id: number;
	rsn: string; // lowercased key
	display_rsn: string | null;
	user_id: string | null;
	discord_id: string | null;
	rank_override: RankValue | null;
	ca_tier_override: string | null;
	gear_points_bonus: number;
	ehb_bonus: number;
	clog_bonus: number;
	months_bonus: number;
	total_level_override: number | null;
	reason: string;
	created_by: string | null;
	created_at: string;
	updated_at: string;
}

const COLS =
	'id, rsn, display_rsn, user_id, discord_id, rank_override, ca_tier_override, gear_points_bonus, ehb_bonus, clog_bonus, months_bonus, total_level_override, reason, created_by, created_at, updated_at';

/** The values an admin can set. Everything but `reason` is optional/clearable. */
export interface RankOverrideInput {
	rsn: string;
	userId?: string | null;
	discordId?: string | null;
	rankOverride?: string | null;
	caTierOverride?: string | null;
	gearPointsBonus?: number;
	ehbBonus?: number;
	clogBonus?: number;
	monthsBonus?: number;
	totalLevelOverride?: number | null;
	reason: string;
}

export const CA_TIERS = CA_TIER_ORDER;

const normRsn = (rsn: string) => rsn.trim().toLowerCase();

// Does this row actually change anything? A row edited back down to "no pin, no tier,
// all zeroes" still exists (its reason is history) but must not be advertised as an
// active adjustment — on the member's profile or in the admin list.
export function hasEffect(ov: RankOverride | null | undefined): boolean {
	if (!ov) return false;
	return (
		ov.rank_override != null ||
		ov.ca_tier_override != null ||
		ov.total_level_override != null ||
		ov.gear_points_bonus !== 0 ||
		Number(ov.ehb_bonus) !== 0 ||
		ov.clog_bonus !== 0 ||
		Number(ov.months_bonus) !== 0
	);
}

// --- Reads ------------------------------------------------------------------

export async function getRankOverride(rsn: string | null | undefined): Promise<RankOverride | null> {
	if (!rsn) return null;
	const { data, error } = await db().from('vs_rank_overrides').select(COLS).eq('rsn', normRsn(rsn)).maybeSingle();
	if (error) {
		console.error('[rank-overrides] lookup failed:', error.message);
		return null;
	}
	return (data as RankOverride | null) ?? null;
}

// Every override keyed by lowercase RSN — the bulk paths (rank-sim refresh, mass
// update) iterate RSNs and would otherwise query per player.
export async function getRankOverridesByRsn(): Promise<Map<string, RankOverride>> {
	const { data, error } = await db().from('vs_rank_overrides').select(COLS);
	if (error) {
		console.error('[rank-overrides] bulk load failed:', error.message);
		return new Map();
	}
	return new Map(((data ?? []) as RankOverride[]).map((r) => [r.rsn, r]));
}

export interface RankOverrideRow extends RankOverride {
	/** The member's site profile, when they have one (display only). */
	profile_rsn: string | null;
	discord_username: string | null;
	/** The rank they currently hold on the shared players row (display only). */
	current_rank: string | null;
}

// The admin list: every override, newest edit first, joined to whatever identity we can
// resolve. Two separate lookups rather than a PostgREST embed — `rsn` is a plain text
// key here, not a foreign key, so there's no relationship to embed through.
export async function listRankOverrides(): Promise<RankOverrideRow[]> {
	const { data, error } = await db().from('vs_rank_overrides').select(COLS).order('updated_at', { ascending: false });
	if (error) {
		console.error('[rank-overrides] list failed:', error.message);
		return [];
	}
	const rows = (data ?? []) as RankOverride[];
	if (rows.length === 0) return [];

	const userIds = [...new Set(rows.map((r) => r.user_id).filter(Boolean))] as string[];
	const rsns = rows.map((r) => r.rsn);

	const [users, players] = await Promise.all([
		userIds.length
			? db().from('vs_users').select('id, rsn, discord_username').in('id', userIds)
			: Promise.resolve({ data: [] }),
		db().from('players').select('rsn, rank')
	]);

	const byUser = new Map(
		((users.data ?? []) as { id: string; rsn: string | null; discord_username: string | null }[]).map((u) => [u.id, u])
	);
	const rankByRsn = new Map(
		((players.data ?? []) as { rsn: string | null; rank: string | null }[])
			.filter((p) => p.rsn && rsns.includes(p.rsn.toLowerCase()))
			.map((p) => [p.rsn!.toLowerCase(), p.rank])
	);

	return rows.map((r) => {
		const u = r.user_id ? byUser.get(r.user_id) : null;
		return {
			...r,
			profile_rsn: u?.rsn ?? null,
			discord_username: u?.discord_username ?? null,
			current_rank: rankByRsn.get(r.rsn) ?? null
		};
	});
}

// --- Writes -----------------------------------------------------------------

export type SaveOverrideResult = { ok: true; rsn: string } | { ok: false; error: string };

// Upsert one member's adjustments. Validates the enumerated fields (an unknown rank or
// CA tier is rejected rather than silently stored and later ignored) and coerces the
// numeric nudges, so a blank form field reads as 0 and not NaN.
export async function saveRankOverride(input: RankOverrideInput, actorId: string): Promise<SaveOverrideResult> {
	const rsn = normRsn(input.rsn);
	if (!rsn) return { ok: false, error: 'Pick a player.' };
	const reason = input.reason.trim();
	if (!reason) return { ok: false, error: 'A reason is required — this is the record of why the rank was changed.' };

	const rank = input.rankOverride?.trim().toLowerCase() || null;
	if (rank && !(RANK_ORDER as readonly string[]).includes(rank)) {
		return { ok: false, error: `“${input.rankOverride}” is not a clan rank.` };
	}
	const caTier = input.caTierOverride?.trim().toLowerCase() || null;
	if (caTier && !CA_TIER_ORDER.includes(caTier)) {
		return { ok: false, error: `“${input.caTierOverride}” is not a combat-achievement tier.` };
	}

	const num = (v: number | undefined) => (Number.isFinite(v) ? Number(v) : 0);
	const { error } = await db()
		.from('vs_rank_overrides')
		.upsert(
			{
				rsn,
				display_rsn: input.rsn.trim(),
				user_id: input.userId || null,
				discord_id: input.discordId || null,
				rank_override: rank,
				ca_tier_override: caTier,
				gear_points_bonus: Math.round(num(input.gearPointsBonus)),
				ehb_bonus: num(input.ehbBonus),
				clog_bonus: Math.round(num(input.clogBonus)),
				months_bonus: num(input.monthsBonus),
				total_level_override:
					input.totalLevelOverride == null || !Number.isFinite(input.totalLevelOverride)
						? null
						: Math.round(input.totalLevelOverride),
				reason,
				created_by: actorId,
				updated_at: new Date().toISOString()
			},
			{ onConflict: 'rsn' }
		);
	return error ? { ok: false, error: error.message } : { ok: true, rsn };
}

export async function clearRankOverride(rsn: string): Promise<{ ok: boolean; error?: string }> {
	const { error } = await db().from('vs_rank_overrides').delete().eq('rsn', normRsn(rsn));
	return error ? { ok: false, error: error.message } : { ok: true };
}

// --- Application (pure) -----------------------------------------------------

// Fold a member's adjustments into their freshly-fetched scoring inputs, in place, and
// return them. Called at fetch time by every scoring path, so the ADJUSTED numbers are
// what gets cached in vs_rank_sim and every reader downstream agrees.
//
// The CA tier override only ever RAISES the component (Math.max): it says "this member
// holds this tier", and a member whose task list already proves more keeps the more.
// The additive nudges may be negative but never take an input below zero.
export function applyRankOverride<T extends RankInputs>(inputs: T, ov: RankOverride | null | undefined): T {
	if (!ov) return inputs;

	if (ov.ca_tier_override) {
		const floor = caPointsForTier(ov.ca_tier_override);
		if (floor > inputs.caPoints) {
			inputs.caPoints = floor;
			// Keep the displayed tier honest about what the member is being scored as.
			const withTier = inputs as T & { caTier?: string; caDetail?: { highestTier?: string } };
			if (withTier.caTier !== undefined) withTier.caTier = ov.ca_tier_override;
			if (withTier.caDetail) withTier.caDetail.highestTier = ov.ca_tier_override;
		}
	}

	if (ov.gear_points_bonus) inputs.gearPoints = Math.max(0, inputs.gearPoints + ov.gear_points_bonus);
	if (Number(ov.ehb_bonus)) inputs.ehb = Math.max(0, inputs.ehb + Number(ov.ehb_bonus));
	if (ov.clog_bonus) {
		inputs.clogFinished = Math.max(0, inputs.clogFinished + ov.clog_bonus);
		// The clog component needs a non-zero `available` to score at all, so a member with
		// no Temple log would otherwise gain nothing from a slot adjustment.
		if (inputs.clogAvailable <= 0) inputs.clogAvailable = inputs.clogFinished;
	}
	if (Number(ov.months_bonus)) inputs.monthsInClan = Math.max(0, inputs.monthsInClan + Number(ov.months_bonus));
	if (ov.total_level_override != null) inputs.totalLevel = ov.total_level_override;

	return inputs;
}

// The rank a member is actually given: the hard pin when one is set, otherwise the
// computed one. Every path that WRITES players.rank or DISPLAYS a rank goes through
// this, so a pin can't be quietly undone by the next bulk apply.
export function resolveRank(computed: RankValue, ov: RankOverride | null | undefined): RankValue {
	return (ov?.rank_override as RankValue | null) ?? computed;
}
