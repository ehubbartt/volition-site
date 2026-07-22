// SERVER-ONLY: "how do I rank up?" advisor. Given a member's cached rank inputs and the
// live scoring config, it works out the fastest, most actionable ways to close the gap to
// their next rank — leaning on the item EHB tables (itemEhb.json boss drops + itemEhc.json
// non-boss clog items) to price gear targets by points-per-hour, and on the composite math
// (rankScoring.ts) to quantify how much each lever moves the score.
//
// It's an ESTIMATE, not a promise: EHB is modelled at max efficiency and only some gear
// items have obtain-time data. The UI (RankPanel) labels it as guidance and uses the
// per-component `potential` to colour the score bars.

import {
	getGearCatalog,
	CA_MAX_POINTS,
	computeScores,
	curveNorm,
	effectiveGearCap,
	describeComposite,
	determineProjectedRank,
	nextCaTier,
	type ComponentKey
} from '../rankScoring';
import type { RankScoringConfig } from '../rankConfig';
import { RANK_LABEL, type RankValue } from '$lib/ranks';
import {
	bestEhbSource,
	DEFAULT_EHB_ASSUMPTIONS,
	type EhbOverrides,
	type ItemEhb,
	type ItemEhc
} from '$lib/ehb';
import itemEhbData from '../data/itemEhb.json';
import itemEhcData from '../data/itemEhc.json';

// The subset of a cached vs_rank_sim row the advisor scores from (the endpoint maps the
// row + its gear_detail / ca_detail JSON into this).
export interface RankAdviceInputs {
	ehb: number;
	totalLevel: number | null;
	gearPoints: number;
	clogFinished: number;
	clogAvailable: number;
	monthsInClan: number;
	caPoints: number;
	caWikiPoints: number;
	gearMatched: string[]; // completed gear-entry names
	gearPartials: { name: string; missing: string[] }[];
}

export interface GearTarget {
	entry: string;
	iconItem: string | null;
	points: number;
	hours: number | null; // real obtain-time (boss/raid or admin-pinned); null when unknown
	pointsPerHour: number | null;
	// Whether the item drops from a boss/raid (itemEhb) — those are the ones we can price
	// with real drop-rate math. Non-boss items are ordered by Temple EHC (easiness) but we
	// don't show a time, since EHC is a category-share, not a reliable standalone grind.
	fromBoss: boolean;
	compositeGain: number; // score this adds if completed (capped by remaining gear headroom)
	fillsClog: boolean; // trackable via the collection log → also nudges the clog bar
	missing: string[]; // the check items still needed
}

export interface AdviceComponent {
	key: ComponentKey;
	label: string;
	weight: number;
	normalized: number; // current fill 0..1
	potential: number; // realistic reachable fill 0..1 (≥ normalized) — drives the bar overlay
	compositeGain: number; // weight × (potential − normalized)
	atCap: boolean;
	advice: string;
	estHours: number | null;
}

export interface AdviceStep {
	key: ComponentKey;
	title: string;
	detail: string;
	compositeGain: number;
	estHours: number | null;
}

export interface RankAdvice {
	available: true;
	composite: number;
	rank: RankValue;
	nextRank: RankValue | null;
	nextThreshold: number | null;
	gap: number; // composite still needed for the next rank (0 at max rank)
	components: AdviceComponent[];
	gearTargets: GearTarget[];
	steps: AdviceStep[];
}

// --- Item → obtain-hours lookup ----------------------------------------------
// Keyed by lowercase item name; rebuilt per call so admin EHB overrides stay fresh.
//
// We ONLY trust real grind-hour estimates here:
//   • Boss/raid drops from itemEhb.json — curated drop-rate ÷ kills-per-hour math (plus
//     admin overrides). These are genuine "hours to obtain".
//   • Non-boss clog items from itemEhc.json are DELIBERATELY excluded: Temple's per-item
//     value is the slot's MARGINAL contribution toward finishing its category, not a
//     standalone grind (a Zenyte shard reads ~5 min, an uncharged trident ~50 min), so it
//     wildly understates obtain time and inflates points-per-hour. A non-boss item is only
//     priced when an admin has explicitly pinned its hours via /admin/ehb (item override);
//     otherwise it shows "no time estimate" and is ranked after everything we can price.
function buildItemHours(overrides: EhbOverrides): Map<string, number> {
	const hours = new Map<string, number>();
	for (const item of itemEhbData as ItemEhb[]) {
		const best = bestEhbSource(item, DEFAULT_EHB_ASSUMPTIONS, overrides);
		if (best && isFinite(best.ehb) && best.ehb > 0) hours.set(item.name.toLowerCase(), best.ehb);
	}
	// Non-boss items: trust ONLY an admin-pinned hours value (override by item id).
	for (const raw of itemEhcData as ItemEhc[]) {
		const pinned = overrides.itemEhb[raw.id];
		if (pinned != null && isFinite(pinned) && pinned > 0) hours.set(raw.name.toLowerCase(), pinned);
	}
	return hours;
}

// Temple's per-item EHC (name → hours), used ONLY as an easiness signal, never as a shown
// time. A low value reliably means "cheap/common pickup" (you get it early in its category)
// even though the absolute number understates the standalone grind.
function buildSoftEhc(): Map<string, number> {
	const m = new Map<string, number>();
	for (const raw of itemEhcData as ItemEhc[]) {
		if (typeof raw.ehc === 'number' && raw.ehc >= 0) m.set(raw.name.toLowerCase(), raw.ehc);
	}
	return m;
}

// Ordering cutoff for non-boss items: those whose still-missing pieces total this much or
// less on the EHC scale sort by that value (cheap/common first); pricier/rarer non-boss
// items (and crafted gear) sort last. Tuned to lift the uncharged trident / warped sceptre
// / zenyte shard band without pulling in rare clue uniques.
const EASY_ENTRY_EHC = 6;

const round1 = (n: number) => Math.round(n * 10) / 10;

// Estimate the hours to finish a gear entry: for each still-missing component take the
// FASTEST accepted alternative, times its quantity, summed. Returns null if no missing
// component has obtain-time data (can't estimate — e.g. crafted Oathplate).
function entryHours(
	components: { names: string[]; qty: number }[],
	missingComponents: { names: string[]; qty: number }[],
	itemHours: Map<string, number>
): number | null {
	const pieces = missingComponents.length ? missingComponents : components;
	let total = 0;
	let anyKnown = false;
	for (const c of pieces) {
		let best: number | null = null;
		for (const n of c.names) {
			const h = itemHours.get(n.toLowerCase());
			if (h != null && (best == null || h < best)) best = h;
		}
		if (best != null) {
			total += best * Math.max(1, c.qty);
			anyKnown = true;
		}
	}
	return anyKnown ? total : null;
}

export function buildRankAdvice(inputs: RankAdviceInputs, config: RankScoringConfig, overrides: EhbOverrides): RankAdvice {
	const scores = computeScores(
		{
			ehb: inputs.ehb,
			totalLevel: inputs.totalLevel,
			gearPoints: inputs.gearPoints,
			clogFinished: inputs.clogFinished,
			clogAvailable: inputs.clogAvailable,
			monthsInClan: inputs.monthsInClan,
			caPoints: inputs.caPoints
		},
		config
	);
	const w = config.weights;
	const caps = config.caps;
	const curves = config.curves ?? { gear: 1, ehb: 1 };
	const gearCap = effectiveGearCap(config);
	const rank = determineProjectedRank(scores.composite, config);

	// Next rank + the composite gap to reach it.
	const thresholds = [...config.thresholds].sort((a, b) => a.scoreMin - b.scoreMin);
	const nextTier = thresholds.find((t) => t.scoreMin > scores.composite) ?? null;
	const nextRank = nextTier?.womRole ?? null;
	const gap = nextTier ? Math.max(0, nextTier.scoreMin - scores.composite) : 0;

	// --- Gear targets: unearned entries, easiest first ---
	const itemHours = buildItemHours(overrides); // real hours (boss/raid + admin pins)
	const softEhc = buildSoftEhc(); // easiness proxy (never shown as a time)
	const bossNames = new Set((itemEhbData as ItemEhb[]).map((i) => i.name.toLowerCase())); // boss/raid drops
	const matched = new Set(inputs.gearMatched.map((n) => n.toLowerCase()));
	const partialByName = new Map(inputs.gearPartials.map((p) => [p.name.toLowerCase(), new Set(p.missing.map((m) => m.toLowerCase()))]));
	// Marginal composite from finishing an entry, under the curve: the score gained by
	// moving gearPoints → gearPoints + entry.points (bigger when you're lower on the bar).
	const gearGainFor = (points: number) =>
		w.gear *
		(curveNorm(inputs.gearPoints + points, gearCap, curves.gear) - curveNorm(inputs.gearPoints, gearCap, curves.gear));

	// Each unearned entry gets an "effort to obtain" used only for ordering (easiest first):
	// real hours when we have them; else the EHC easiness proxy for cheap non-boss items;
	// else Infinity (crafted / rare / unknown → sorted last).
	const scored: { target: GearTarget; effort: number }[] = [];
	for (const entry of getGearCatalog()) {
		if (matched.has(entry.name.toLowerCase())) continue; // already fully earned
		const missingSet = partialByName.get(entry.name.toLowerCase());
		// Which components still need doing (partial → only the unmet ones; else all).
		const missingComponents = missingSet
			? entry.components.filter((c) => missingSet.has(c.names[0].toLowerCase()))
			: entry.components;
		const hours = entryHours(entry.components, missingComponents, itemHours);
		// A boss/raid item if any still-missing piece is a curated boss drop.
		const fromBoss = missingComponents.some((c) => c.names.some((n) => bossNames.has(n.toLowerCase())));

		let effort: number;
		if (hours != null) {
			effort = hours;
		} else {
			// No real time: order cheap non-boss pickups by their EHC (easiness proxy only,
			// never shown); rare/crafted items with no cheap path sort last.
			const soft = entryHours(entry.components, missingComponents, softEhc);
			effort = soft != null && soft <= EASY_ENTRY_EHC ? soft : Infinity;
		}
		scored.push({
			effort,
			target: {
				entry: entry.name,
				iconItem: entry.iconItem,
				points: entry.points,
				hours: hours != null ? round1(hours) : null,
				pointsPerHour: hours && hours > 0 ? Math.round((entry.points / hours) * 10) / 10 : null,
				fromBoss,
				compositeGain: gearGainFor(entry.points),
				fillsClog: !entry.claimable,
				missing: missingComponents.map((c) => c.names[0])
			}
		});
	}
	// Easiest first (least effort to obtain); tie-break on more points, so a quick win and a
	// cheap boss drop of equal effort lead with the bigger score.
	scored.sort((a, b) => a.effort - b.effort || b.target.points - a.target.points);
	const gearTargets = scored.map((s) => s.target);
	const topGear = gearTargets.slice(0, 10);
	const topGearPoints = topGear.reduce((s, t) => s + t.points, 0);
	const topGearHours = topGear.reduce((s, t) => s + (t.hours ?? 0), 0);
	const topGearClogSlots = topGear.filter((t) => t.fillsClog).length;

	// --- Per-component headroom + a realistic "potential" for the bar overlay ---
	const details = describeComposite(scores, config);
	const caNext = nextCaTier(inputs.caWikiPoints);
	const components: AdviceComponent[] = details.map((d) => {
		const n = d.normalized;
		let potential = n;
		let advice = '';
		let estHours: number | null = null;
		switch (d.key) {
			case 'gear': {
				// Reachable fill after finishing the top targets, under the curve.
				potential = curveNorm(inputs.gearPoints + topGearPoints, gearCap, curves.gear);
				estHours = topGearHours > 0 ? round1(topGearHours) : null;
				advice = topGear.length
					? `Chase the fastest gear below — the top ${topGear.length} are worth ${topGearPoints} points${estHours ? ` (~${estHours}h)` : ''}.`
					: 'Every gear entry is earned — nothing left here.';
				break;
			}
			case 'ehb': {
				// Bossing those gear drops also raises EHB; show that as the reachable gain (curved).
				potential = curveNorm(inputs.ehb + topGearHours, caps.ehb, curves.ehb);
				estHours = topGearHours > 0 ? round1(topGearHours) : null;
				advice =
					n >= 1
						? 'EHB is maxed for rank.'
						: topGearHours > 0
							? `Bossing for the gear above adds ~${round1(topGearHours)} EHB along the way.`
							: 'More efficient bossing raises this — every hour counts toward the cap.';
				break;
			}
			case 'clog': {
				const add = caps.clog > 0 ? Math.min(1 - n, topGearClogSlots / caps.clog) : 0;
				potential = Math.min(1, n + add);
				advice =
					n >= 1
						? 'Collection log is maxed for rank.'
						: `Each new log slot counts — the trackable gear above fills ~${topGearClogSlots} slots. Clue scrolls and boss uniques are the quickest slots.`;
				break;
			}
			case 'ca': {
				const rewardGain = caNext && CA_MAX_POINTS > 0 ? Math.min(1 - n, caNext.reward / CA_MAX_POINTS) : 0;
				potential = Math.min(1, n + rewardGain);
				advice = caNext
					? `Finish the ${caNext.tier} CA tier (about ${caNext.pointsNeeded} more CA points) to bank its reward — partly-done tiers score nothing.`
					: 'Every combat-achievement tier is banked.';
				break;
			}
			case 'level': {
				// A realistic near-term bump: +50 total levels.
				const add = caps.levelRange > 0 ? Math.min(1 - n, 50 / caps.levelRange) : 0;
				potential = Math.min(1, n + add);
				advice =
					n >= 1
						? 'Total level is maxed for rank.'
						: `Raise your total level — it only counts above ${caps.levelMin}, and each level nudges this bar.`;
				break;
			}
			case 'time': {
				const add = caps.months > 0 ? Math.min(1 - n, 3 / caps.months) : 0;
				potential = Math.min(1, n + add);
				advice = n >= 1 ? 'Max time-in-clan credit reached.' : 'This one is automatic — it climbs the longer you stay in the clan.';
				break;
			}
		}
		return {
			key: d.key,
			label: d.label,
			weight: d.weight,
			normalized: n,
			potential,
			compositeGain: d.weight * Math.max(0, potential - n),
			atCap: n >= 1,
			advice,
			estHours
		};
	});

	// --- Ordered "guide" steps: biggest actionable score gain first ---
	const steps: AdviceStep[] = components
		.filter((c) => c.key !== 'time' && c.compositeGain > 0.0005)
		.map((c) => ({ key: c.key, title: stepTitle(c.key, nextRank), detail: c.advice, compositeGain: c.compositeGain, estHours: c.estHours }))
		.sort((a, b) => b.compositeGain - a.compositeGain);

	return {
		available: true,
		composite: scores.composite,
		rank,
		nextRank,
		nextThreshold: nextTier?.scoreMin ?? null,
		gap,
		components,
		gearTargets: topGear,
		steps
	};
}

function stepTitle(key: ComponentKey, nextRank: RankValue | null): string {
	const toward = nextRank ? ` toward ${RANK_LABEL[nextRank]}` : '';
	switch (key) {
		case 'gear':
			return `Grab the fastest gear points${toward}`;
		case 'ehb':
			return 'Bank efficient bossing hours';
		case 'clog':
			return 'Fill more collection-log slots';
		case 'ca':
			return 'Complete your next combat-achievement tier';
		case 'level':
			return 'Push your total level';
		default:
			return 'Keep going';
	}
}
