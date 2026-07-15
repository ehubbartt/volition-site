import { db } from './db';
import type { SessionUser } from './auth';
import { CLAN_OPTIONS } from '$lib/clans';
import { ACCOUNT_TYPES } from '$lib/accountTypes';
import { loadCardProfile } from './cardProfile';
import { getPlayerRank } from './playerStats';
import { rsnExactPattern } from './users';
import { getRankConfig, type RankScoringConfig } from './rankConfig';
import { listGearClaims, claimableGearItems } from './rankClaims';
import type { GearDetail, CADetail } from './rankData';
import {
	computeScores,
	determineProjectedRank,
	describeComposite,
	getGearCatalog,
	GEAR_SCORE_CAP,
	CA_MAX_POINTS
} from './rankScoring';
import type { RankValue } from '$lib/ranks';

// Builds the /me page dataset for /api/me. The page has NO server load — its
// universal load fires the fetch without awaiting, so navigating to /me completes
// instantly and this streams in behind the skeleton.

// Gear tiers ordered for the collection-log grid (top gear leads); labels for headers.
const GEAR_TIER_ORDER = ['end', 'middle', 'low', 'side'];
const GEAR_TIER_LABEL: Record<string, string> = {
	end: 'End-game',
	middle: 'Mid tier',
	low: 'Low tier',
	side: 'Side grades'
};

interface GearPiece {
	name: string;
	iconItem: string | null;
	earned: number;
	max: number;
	owned: boolean;
}
interface GearTierGroup {
	tier: string;
	label: string;
	pieces: GearPiece[];
}

// Merge the static gear catalog (every piece + tier + representative icon item) with the
// cached row's earned points, so the grid shows ALL pieces — owned in colour, missing
// dimmed — grouped by tier. Works off whatever gear_detail is cached (empty → all missing).
function buildGearGrid(detail: GearDetail | null): { grid: GearTierGroup[]; owned: number; total: number } {
	const earned = new Map<string, number>();
	if (detail) for (const m of detail.matchedItems) earned.set(m.name, m.earned);

	const groups = new Map<string, GearTierGroup>();
	let owned = 0;
	const catalog = getGearCatalog();
	for (const entry of catalog) {
		const got = earned.get(entry.name) ?? 0;
		if (got > 0) owned++;
		let group = groups.get(entry.tier);
		if (!group) {
			group = { tier: entry.tier, label: GEAR_TIER_LABEL[entry.tier] ?? entry.tier, pieces: [] };
			groups.set(entry.tier, group);
		}
		group.pieces.push({
			name: entry.name,
			iconItem: entry.iconItem,
			earned: got,
			max: entry.points,
			owned: got > 0
		});
	}

	const ordered = [
		...GEAR_TIER_ORDER.filter((t) => groups.has(t)).map((t) => groups.get(t)!),
		...[...groups.values()].filter((g) => !GEAR_TIER_ORDER.includes(g.tier))
	];
	for (const g of ordered) {
		g.pieces.sort((a, b) => Number(b.owned) - Number(a.owned) || b.max - a.max);
	}
	return { grid: ordered, owned, total: catalog.length };
}

// The subset of the vs_rank_sim cache row the Rank tab renders from. Populated by
// the member's own "Check my rank" and by the admin rank-sim refresh.
interface RankSimRow {
	rsn: string;
	ehb: number;
	total_level: number | null;
	gear_points: number;
	clog_finished: number;
	clog_available: number;
	months_in_clan: number;
	ca_points: number;
	temple_available: boolean;
	wikisync_available: boolean;
	ca_tier: string;
	gear_detail: GearDetail | null;
	ca_detail: CADetail | null;
	fetched_at: string | null;
}

const SIM_ROW_COLUMNS =
	'rsn, ehb, total_level, gear_points, clog_finished, clog_available, months_in_clan, ca_points, temple_available, wikisync_available, ca_tier, gear_detail, ca_detail, fetched_at';

// Build the full per-section breakdown the /me Rank tab shows, recomputing scores
// from the cached row with the CURRENT config so it stays in sync as the formula is
// tuned. Pairs each weighted component with its raw input + cap for "x / cap" display.
function buildRankBreakdown(row: RankSimRow, config: RankScoringConfig) {
	const scores = computeScores(
		{
			ehb: row.ehb,
			totalLevel: row.total_level,
			gearPoints: row.gear_points,
			clogFinished: row.clog_finished,
			clogAvailable: row.clog_available,
			monthsInClan: row.months_in_clan,
			caPoints: row.ca_points
		},
		config
	);
	const rawByKey: Record<string, { raw: number; cap: number }> = {
		gear: { raw: row.gear_points, cap: GEAR_SCORE_CAP },
		ehb: { raw: Math.round(row.ehb), cap: config.caps.ehb },
		ca: { raw: row.ca_points, cap: CA_MAX_POINTS },
		time: { raw: Math.round(row.months_in_clan * 10) / 10, cap: config.caps.months },
		clog: { raw: row.clog_finished, cap: config.caps.clog },
		level: { raw: row.total_level ?? 0, cap: config.caps.levelMin + config.caps.levelRange }
	};
	const components = describeComposite(scores, config).map((c) => ({
		...c,
		raw: rawByKey[c.key].raw,
		cap: rawByKey[c.key].cap
	}));

	const gear = buildGearGrid(row.gear_detail);

	// "How close am I to the next rank?" — thresholds map composite → rank; the
	// next tier up (if any) gives the target, and progress is measured within the
	// current tier's band so the bar restarts at each rank-up.
	const thresholds = [...config.thresholds].sort((a, b) => a.scoreMin - b.scoreMin);
	const nextTier = thresholds.find((t) => t.scoreMin > scores.composite) ?? null;
	const curMin = thresholds.filter((t) => t.scoreMin <= scores.composite).at(-1)?.scoreMin ?? 0;
	const nextRankProgress = nextTier
		? Math.min(1, Math.max(0, (scores.composite - curMin) / (nextTier.scoreMin - curMin)))
		: 1;

	return {
		rank: determineProjectedRank(scores.composite, config) as RankValue,
		composite: scores.composite,
		nextRank: (nextTier?.womRole ?? null) as RankValue | null,
		nextThreshold: nextTier?.scoreMin ?? null,
		nextRankProgress,
		components,
		gearGrid: gear.grid,
		gearOwned: gear.owned,
		gearTotal: gear.total,
		caDetail: row.ca_detail,
		templeAvailable: row.temple_available,
		wikisyncAvailable: row.wikisync_available,
		fetchedAt: row.fetched_at
	};
}

// Load a player's rank breakdown from their cached vs_rank_sim row, recomputed with
// the live config. Null when they've never been fetched (no "Check my rank" and no
// admin rank-sim refresh yet). Shared by /me's Rank tab and the public /u/[rsn] one.
// Freshest-first with limit(1), NOT maybeSingle: two writers key this table (the
// admin rank-sim uses the WOM canonical rsn, "Check my rank" the profile rsn), so a
// case/underscore variant can leave two rows for one player — maybeSingle errors on
// that and the tab silently shows nothing.
// The error string is for the OWNER's /me tab (and the server log) — a query
// failure used to be discarded here, which made "Check my rank" look like it did
// nothing. Public callers (/u/[rsn]) render the breakdown only and never show it.
export async function loadRankBreakdown(rsn: string | null): Promise<{
	breakdown: ReturnType<typeof buildRankBreakdown> | null;
	error: string | null;
}> {
	if (!rsn) return { breakdown: null, error: null };
	const [config, { data: simRows, error: simErr }] = await Promise.all([
		getRankConfig(),
		db()
			.from('vs_rank_sim')
			.select(SIM_ROW_COLUMNS)
			.ilike('rsn', rsnExactPattern(rsn))
			.order('fetched_at', { ascending: false })
			.limit(1)
	]);
	if (simErr) {
		const detail = `vs_rank_sim lookup failed for "${rsn}": ${simErr.message}${simErr.code ? ` (${simErr.code})` : ''}`;
		console.error('[rank] ' + detail);
		return { breakdown: null, error: detail };
	}
	const simRow = simRows?.[0];
	return { breakdown: simRow ? buildRankBreakdown(simRow as RankSimRow, config) : null, error: null };
}

export async function buildMeData(user: SessionUser) {
	const [profile, currentRank, rank, gearClaims] = await Promise.all([
		loadCardProfile(user),
		getPlayerRank(user.discord_id, user.rsn),
		loadRankBreakdown(user.rsn),
		listGearClaims(user.id)
	]);

	return {
		clanOptions: CLAN_OPTIONS,
		accountTypes: ACCOUNT_TYPES,
		currentRank,
		rankBreakdown: rank.breakdown,
		rankBreakdownError: rank.error,
		// Manual gear claims (untrackable items): the member's own claims + the
		// claimable gear-table item names for the submit form's picker.
		gearClaims,
		claimableGear: claimableGearItems(),
		vp_balance: profile.vp_balance,
		gold_balance: profile.gold_balance,
		wallet: profile.wallet,
		walletGpValue: profile.walletGpValue,
		collection: profile.collection,
		collectionOwned: profile.collectionOwned,
		collectionTotal: profile.collectionTotal,
		myStats: profile.stats,
		crateStats: profile.crateStats,
		packs: profile.packs
	};
}

