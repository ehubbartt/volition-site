// SERVER-ONLY composite rank scoring — ported VERBATIM (logic-wise) from the bot's
// voli-disc-bot/scripts/simulateRanks.js so the site's projected ranks match the
// simulation that tuned them. PURE functions only (no I/O): both the on-profile
// "Check my rank" action and the admin rank-sim recalc feed raw player inputs +
// the tunable RankScoringConfig (from bot_config, see rankConfig.ts) through here.
//
// composite = gear*0.35 + ehb*0.25 + ca*0.10 + time*0.10 + clog*0.10 + level*0.10
// (weights/thresholds/caps are config-driven; the gear point table + CA point map
// are bundled reference data that rarely changes — gearScoring.json /
// combatAchievements.json, copied from the bot's config/.)

import gearScoring from './rankScoring/gearScoring.json';
import combatAchievements from './rankScoring/combatAchievements.json';
import type { RankScoringConfig } from './rankConfig';
import type { RankValue } from '$lib/ranks';

// --- Reference data shapes (the bundled JSON) ------------------------------
interface GearCheck {
	name: string | string[]; // a single item, or OR-alternatives
	quantity?: number;
}
interface GearEntry {
	name: string;
	tier: string;
	points: number;
	// Untrackable via the Temple clog (GE-bought / combined outside the log) — the
	// gear grid marks these with a click-to-claim affordance (manual gear claims).
	claimable?: boolean;
	// Display-icon override (item name) when the clog check item isn't what to show —
	// e.g. DT2 rings check the vestige clog unlock but display the ring.
	icon?: string;
	items: GearCheck[];
}
interface GearScoring {
	GEAR_SCORE_CAP: number;
	gear: GearEntry[];
}
interface CombatAchievements {
	tierCompletionRewards: Record<string, number>;
	maxPoints: number;
	tiers: Record<string, { cumulativeForReward: number }>;
	tasks: Record<string, number>;
}

const GEAR: GearScoring = gearScoring as GearScoring;
const CA: CombatAchievements = combatAchievements as CombatAchievements;

export const GEAR_SCORE_CAP = GEAR.GEAR_SCORE_CAP;
export const CA_MAX_POINTS = CA.maxPoints;

// --- Raw inputs a player is scored from -------------------------------------
export interface RankInputs {
	ehb: number;
	totalLevel: number | null;
	gearPoints: number;
	clogFinished: number;
	clogAvailable: number;
	monthsInClan: number;
	caPoints: number;
}

export interface ScoreBreakdown {
	composite: number;
	gear: number;
	ehb: number;
	ca: number;
	time: number;
	clog: number;
	level: number;
}

// --- Gear: match a Temple collection-log payload against the gear table ------
// `templeItems` is Temple's `data.items` (categories → arrays of { name, count }).
// Mirrors simulateRanks.calculateGearPoints: OR-alternatives take the best count,
// quantity>1 gives proportional credit, otherwise binary has-it, scaled by points.
export interface TempleItem {
	name: string;
	count?: number;
}
export type TempleItems = Record<string, TempleItem[] | unknown>;

// A partially-obtained gear entry: some but not all of its checks are satisfied. Points
// are ALL-OR-NOTHING (an unassembled item isn't the item), so a partial scores 0 and is
// surfaced separately so the grid can show its in-progress state + what's still needed.
// `missing` lists each unmet check's display item name (first OR-alternative).
export interface GearPartial {
	name: string; // the gear-table entry name
	haveChecks: number;
	totalChecks: number;
	missing: string[];
}

export function calculateGearPoints(
	templeItems: TempleItems | null | undefined,
	// Admin-approved manual gear claims (rankClaims.ts) — item names that count as
	// owned (count 1) even though the Temple clog can't prove them (GE-bought pieces,
	// upgraded variants combined outside the log).
	manualItemNames?: string[]
): {
	gearPoints: number;
	matchedItems: { name: string; earned: number; max: number }[];
	missedItems: string[];
	partials: GearPartial[];
} {
	if (!templeItems && !manualItemNames?.length) {
		return { gearPoints: 0, matchedItems: [], missedItems: [], partials: [] };
	}

	// Flat lookup: itemName (lowercase) -> max count across all categories.
	const playerItems: Record<string, number> = {};
	for (const category of Object.values(templeItems ?? {})) {
		if (!Array.isArray(category)) continue;
		for (const item of category as TempleItem[]) {
			if (!item?.name) continue;
			const key = item.name.toLowerCase();
			playerItems[key] = Math.max(playerItems[key] || 0, item.count || 1);
		}
	}
	for (const name of manualItemNames ?? []) {
		const key = name.toLowerCase();
		playerItems[key] = Math.max(playerItems[key] || 0, 1);
	}

	let totalPoints = 0;
	const matchedItems: { name: string; earned: number; max: number }[] = [];
	const missedItems: string[] = [];
	const partials: GearPartial[] = [];

	for (const gear of GEAR.gear) {
		const itemChecks = gear.items;
		const totalChecks = itemChecks.length;
		let checksPassed = 0;
		const missing: string[] = []; // display name of each unmet check

		for (const check of itemChecks) {
			const names = Array.isArray(check.name) ? check.name : [check.name];
			const requiredQty = check.quantity || 1;

			let bestCount = 0;
			for (const name of names) {
				const count = playerItems[name.toLowerCase()] || 0;
				bestCount = Math.max(bestCount, count);
			}

			const met = bestCount >= requiredQty;
			if (met) checksPassed += 1;
			else missing.push(requiredQty > 1 ? `${names[0]} ×${requiredQty}` : names[0]);
		}

		// ALL-OR-NOTHING: points only when EVERY check is satisfied; a partial scores 0
		// and is reported for the in-progress UI (never awarded until completed).
		if (checksPassed === totalChecks && totalChecks > 0) {
			matchedItems.push({ name: gear.name, earned: gear.points, max: gear.points });
			totalPoints += gear.points;
		} else if (checksPassed > 0) {
			partials.push({ name: gear.name, haveChecks: checksPassed, totalChecks, missing });
			missedItems.push(gear.name);
		} else {
			missedItems.push(gear.name);
		}
	}

	return { gearPoints: totalPoints, matchedItems, missedItems, partials };
}

// --- Gear catalog (for the on-profile collection-log-style grid) -------------
// The full gear table flattened to display rows: each entry's name, tier, max
// points, and a REPRESENTATIVE item to show an icon for. The entry `name` is a set
// label (e.g. "Ahrim/Bluemoon Robe Set"), often not an item — so the icon item is
// taken from the first required item check (its first OR-alternative), UNLESS the
// entry sets an explicit `icon` (e.g. DT2 rings display the ring, not the vestige
// clog check). `iconItem` drives display + wiki; `checkItem` is the clog-tracked
// name used for manual-claim matching — they diverge when `icon` is set. Built once.
export interface GearCatalogEntry {
	name: string;
	tier: string;
	points: number;
	iconItem: string | null; // display / wiki
	checkItem: string | null; // clog check name (claim + scoring match target)
	claimable: boolean;
}

let gearCatalog: GearCatalogEntry[] | null = null;
export function getGearCatalog(): GearCatalogEntry[] {
	if (gearCatalog) return gearCatalog;
	gearCatalog = GEAR.gear.map((g) => {
		const first = g.items[0]?.name;
		const checkItem = Array.isArray(first) ? (first[0] ?? null) : (first ?? null);
		return {
			name: g.name,
			tier: g.tier,
			points: g.points,
			iconItem: g.icon ?? checkItem, // explicit display icon wins
			checkItem,
			claimable: g.claimable === true
		};
	});
	return gearCatalog;
}

// --- Combat achievements: tier-completion points from WikiSync task ids ------
// Mirrors simulateRanks.calculateCAPoints: sum wiki points from completed tasks,
// then award each FULLY-completed tier's reward (cumulative thresholds).
const CA_TIER_ORDER = ['easy', 'medium', 'hard', 'elite', 'master', 'grandmaster'];

export function calculateCAPoints(completedTaskIds: number[] | null | undefined): {
	caPoints: number;
	tasksCompleted: number;
	wikiPoints: number;
	highestTier: string;
} {
	if (!completedTaskIds || !completedTaskIds.length) {
		return { caPoints: 0, tasksCompleted: 0, wikiPoints: 0, highestTier: 'none' };
	}

	let wikiPoints = 0;
	let tasksCompleted = 0;
	for (const taskId of completedTaskIds) {
		const pts = CA.tasks[String(taskId)];
		if (pts) {
			wikiPoints += pts;
			tasksCompleted++;
		}
	}

	let caPoints = 0;
	let highestTier = 'none';
	for (const tier of CA_TIER_ORDER) {
		const threshold = CA.tiers[tier]?.cumulativeForReward;
		if (threshold != null && wikiPoints >= threshold) {
			caPoints += CA.tierCompletionRewards[tier] ?? 0;
			highestTier = tier;
		} else {
			break;
		}
	}

	return { caPoints, tasksCompleted, wikiPoints, highestTier };
}

// --- Normalizations (all clamped 0..1), caps from RankScoringConfig ----------
const clamp01 = (n: number) => Math.max(0, Math.min(1, n));

export function computeScores(inputs: RankInputs, config: RankScoringConfig): ScoreBreakdown {
	const caps = config.caps;
	const w = config.weights;

	const gear = GEAR_SCORE_CAP > 0 ? clamp01(inputs.gearPoints / GEAR_SCORE_CAP) : 0;
	const ehb = inputs.ehb > 0 && caps.ehb > 0 ? clamp01(inputs.ehb / caps.ehb) : 0;
	const ca = inputs.caPoints > 0 && CA_MAX_POINTS > 0 ? clamp01(inputs.caPoints / CA_MAX_POINTS) : 0;
	const time = caps.months > 0 ? clamp01(inputs.monthsInClan / caps.months) : 0;
	const clog =
		inputs.clogFinished > 0 && inputs.clogAvailable > 0 && caps.clog > 0
			? clamp01(inputs.clogFinished / caps.clog)
			: 0;
	const level =
		inputs.totalLevel && inputs.totalLevel >= caps.levelMin && caps.levelRange > 0
			? clamp01((inputs.totalLevel - caps.levelMin) / caps.levelRange)
			: 0;

	const composite =
		gear * w.gear + ehb * w.ehb + ca * w.ca + time * w.time + clog * w.clog + level * w.level;

	return { composite, gear, ehb, ca, time, clog, level };
}

// --- Per-component description (for the on-profile rank breakdown) -----------
// Turn a ScoreBreakdown + config into the six weighted components, in display
// order, each with its weight, normalized 0..1 score, and weighted contribution
// to the composite (normalized × weight). Pure — the /me Rank tab pairs this with
// the raw inputs (gearPoints, ehb, …) and caps for the "x / cap" displays.
export type ComponentKey = 'gear' | 'ehb' | 'ca' | 'time' | 'clog' | 'level';

export interface ComponentDetail {
	key: ComponentKey;
	label: string;
	weight: number;
	normalized: number;
	contribution: number;
}

const COMPONENT_LABELS: { key: ComponentKey; label: string }[] = [
	{ key: 'gear', label: 'Gear' },
	{ key: 'ehb', label: 'Efficient hours bossed' },
	{ key: 'ca', label: 'Combat achievements' },
	{ key: 'time', label: 'Time in clan' },
	{ key: 'clog', label: 'Collection log' },
	{ key: 'level', label: 'Total level' }
];

export function describeComposite(scores: ScoreBreakdown, config: RankScoringConfig): ComponentDetail[] {
	const w = config.weights;
	return COMPONENT_LABELS.map(({ key, label }) => ({
		key,
		label,
		weight: w[key],
		normalized: scores[key],
		contribution: scores[key] * w[key]
	}));
}

// Map a composite score (0..1) to a rank womRole using the configured thresholds
// (highest-threshold-first, mirroring simulateRanks.determineProjectedRank).
export function determineProjectedRank(composite: number, config: RankScoringConfig): RankValue {
	const thresholds = config.thresholds;
	for (let i = thresholds.length - 1; i >= 0; i--) {
		if (composite >= thresholds[i].scoreMin) return thresholds[i].womRole;
	}
	return 'bronze';
}

// Convenience: full pipeline from raw inputs → { scores, rank }.
export function scorePlayer(
	inputs: RankInputs,
	config: RankScoringConfig
): { scores: ScoreBreakdown; rank: RankValue } {
	const scores = computeScores(inputs, config);
	return { scores, rank: determineProjectedRank(scores.composite, config) };
}
