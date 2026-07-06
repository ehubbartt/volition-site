import { db } from './db';
import type { SessionUser } from './auth';
import { CLAN_OPTIONS } from '$lib/clans';
import { ACCOUNT_TYPES } from '$lib/accountTypes';
import { loadCardProfile } from './cardProfile';
import { getPlayerRank } from './playerStats';
import { getRankConfig, type RankScoringConfig } from './rankConfig';
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

	return {
		rank: determineProjectedRank(scores.composite, config) as RankValue,
		composite: scores.composite,
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

export async function buildMeData(user: SessionUser) {
	const [profile, currentRank] = await Promise.all([
		loadCardProfile(user),
		getPlayerRank(user.discord_id, user.rsn)
	]);

	// Rank tab: render from the member's cached vs_rank_sim row (recomputed with the
	// live config). Null until they "Check my rank" or an admin refresh fetches them.
	let rankBreakdown: ReturnType<typeof buildRankBreakdown> | null = null;
	if (user.rsn) {
		const [config, { data: simRow }] = await Promise.all([
			getRankConfig(),
			db().from('vs_rank_sim').select(SIM_ROW_COLUMNS).ilike('rsn', user.rsn).maybeSingle()
		]);
		if (simRow) rankBreakdown = buildRankBreakdown(simRow as RankSimRow, config);
	}

	return {
		clanOptions: CLAN_OPTIONS,
		accountTypes: ACCOUNT_TYPES,
		currentRank,
		rankBreakdown,
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

