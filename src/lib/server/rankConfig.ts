import { db } from './db';
import { toRankValue, type RankValue } from '$lib/ranks';

// SERVER-ONLY tunable rank-scoring config. Stored in the SHARED Supabase `bot_config`
// table (config_name='rank_scoring', config_group='ranks') — the SAME mechanism the
// loot tables use (see lootcrate.ts getLootConfig) and the SAME table the generic
// admin config editor edits, so no new editor code is needed. Holds the composite
// weights, the score→rank thresholds, and the normalization caps the admin rank-sim
// tunes; the gear point table + CA point map stay in rankScoring/*.json.
//
// NOTE: we only READ/UPSERT this one row. We do NOT touch src/routes/admin/config/*.

export interface RankWeights {
	gear: number;
	ehb: number;
	ca: number;
	time: number;
	clog: number;
	level: number;
}

export interface RankCaps {
	ehb: number; // EHB at which the ehb component maxes (default 3000)
	months: number; // months-in-clan cap (default 12)
	clog: number; // collection-log slots cap (default 1200)
	levelMin: number; // total level floor before any credit (default 2000)
	levelRange: number; // level span above the floor for full credit (default 376 → 2376)
	// Gear points at which the gear component maxes. 0 (default) = use the gear table's
	// full point sum (GEAR_SCORE_CAP) — i.e. today's behaviour. Set a lower value so a
	// strong-but-not-BiS setup reads near full and the mid-game isn't flat.
	gear: number;
}

// Diminishing-returns exponents applied to the gear and EHB components before weighting:
// normalized = (raw / cap) ** exponent. 1 = linear (today). A value < 1 (e.g. 0.5 = sqrt)
// front-loads the reward so early hours/gear move the score most — where most of the
// roster actually sits — while the cap still tops out at 1. Other components stay linear.
export interface RankCurves {
	gear: number;
	ehb: number;
}

export interface RankThreshold {
	scoreMin: number; // inclusive composite-score floor for this rank
	womRole: RankValue;
}

export interface RankScoringConfig {
	weights: RankWeights;
	caps: RankCaps;
	curves: RankCurves;
	thresholds: RankThreshold[];
}

// Defaults ported from the bot's original rank-scoring formula (composite weights +
// thresholds + normalization caps). The live values are the bot_config row tuned via
// the admin rank-sim; this constant is the FALLBACK used only when that row is missing
// or unreadable. The gear point table + CA point map live in rankScoring/*.json, which
// are now the canonical copies (the bot's source script has since been removed) — keep
// them in sync by hand if the bot's tables change.
export const DEFAULT_RANK_CONFIG: RankScoringConfig = {
	weights: { gear: 0.35, ehb: 0.25, ca: 0.1, time: 0.1, clog: 0.1, level: 0.1 },
	// gear: 0 = normalize against the gear table's full point sum (today's behaviour).
	caps: { ehb: 3000, months: 12, clog: 1200, levelMin: 2000, levelRange: 376, gear: 0 },
	// 1 / 1 = linear (today's behaviour). Lower to front-load progression (0.5 = sqrt).
	curves: { gear: 1, ehb: 1 },
	thresholds: [
		{ scoreMin: 0.0, womRole: 'bronze' },
		{ scoreMin: 0.08, womRole: 'iron' },
		{ scoreMin: 0.14, womRole: 'steel' },
		{ scoreMin: 0.2, womRole: 'gold' },
		{ scoreMin: 0.27, womRole: 'mithril' },
		{ scoreMin: 0.35, womRole: 'adamant' },
		{ scoreMin: 0.43, womRole: 'rune' },
		{ scoreMin: 0.52, womRole: 'dragon' },
		{ scoreMin: 0.62, womRole: 'sage' },
		{ scoreMin: 0.72, womRole: 'legend' },
		{ scoreMin: 0.82, womRole: 'myth' },
		{ scoreMin: 0.9, womRole: 'tztok' },
		{ scoreMin: 0.95, womRole: 'tzkal' }
	]
};

export const RANK_CONFIG_NAME = 'rank_scoring';
export const RANK_CONFIG_GROUP = 'ranks';

let cache: { value: RankScoringConfig; at: number } | null = null;
let inflight: Promise<RankScoringConfig> | null = null;
const CACHE_TTL_MS = 60_000;

// Coerce/repair a stored config so a partial or hand-edited row can't break scoring:
// fall back field-by-field to the defaults, and keep thresholds in valid rank order.
function sanitize(raw: unknown): RankScoringConfig {
	const r = (raw ?? {}) as Partial<RankScoringConfig>;
	const merged = { ...DEFAULT_RANK_CONFIG.weights, ...(r.weights ?? {}) };
	// The composite is Σ(component·weight) and the thresholds are calibrated for weights
	// that sum to 1. A hand-edited row whose weights sum to e.g. 1.3 would scale every
	// score up and make the thresholds meaningless, so normalise to sum 1 here (keeping
	// the admin's relative emphasis). Falls back to the defaults if the sum is non-positive.
	const keys = Object.keys(DEFAULT_RANK_CONFIG.weights) as (keyof RankWeights)[];
	const total = keys.reduce((s, k) => s + (Number(merged[k]) || 0), 0);
	const weights = { ...DEFAULT_RANK_CONFIG.weights };
	if (total > 0) for (const k of keys) weights[k] = (Number(merged[k]) || 0) / total;
	const caps = { ...DEFAULT_RANK_CONFIG.caps, ...(r.caps ?? {}) };
	// Curve exponents: default to linear, then clamp to a sane diminishing-returns band so a
	// hand-edited row can't invert the curve or divide by zero (0.2 = very front-loaded, 1 = linear).
	const clampExp = (v: unknown, fallback: number) => {
		const n = Number(v);
		return Number.isFinite(n) && n > 0 ? Math.min(1, Math.max(0.2, n)) : fallback;
	};
	const curves: RankCurves = {
		gear: clampExp(r.curves?.gear, DEFAULT_RANK_CONFIG.curves.gear),
		ehb: clampExp(r.curves?.ehb, DEFAULT_RANK_CONFIG.curves.ehb)
	};
	let thresholds = Array.isArray(r.thresholds) ? r.thresholds : DEFAULT_RANK_CONFIG.thresholds;
	thresholds = thresholds
		.filter((t) => t && toRankValue(t.womRole) && typeof t.scoreMin === 'number')
		.sort((a, b) => a.scoreMin - b.scoreMin);
	if (thresholds.length === 0) thresholds = DEFAULT_RANK_CONFIG.thresholds;
	return { weights, caps, curves, thresholds };
}

// Read the rank-scoring config from bot_config, cached for a minute. Pass force=true
// to bypass the cache (the rank-sim uses this so an admin's edits apply immediately,
// mirroring getLootConfig(true)). Falls back to DEFAULT_RANK_CONFIG if unavailable.
export async function getRankConfig(force = false): Promise<RankScoringConfig> {
	if (!force && cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.value;
	// De-dupe concurrent (re)loads: the first caller does the DB read and everyone
	// waiting shares its promise, so a burst of checkRank calls hits bot_config once.
	if (!force && inflight) return inflight;

	const load = (async () => {
		try {
			const { data } = await db()
				.from('bot_config')
				.select('config_value')
				.eq('config_name', RANK_CONFIG_NAME)
				.maybeSingle();
			const value = data?.config_value ? sanitize(data.config_value) : DEFAULT_RANK_CONFIG;
			cache = { value, at: Date.now() };
			return value;
		} catch {
			return DEFAULT_RANK_CONFIG;
		}
	})();

	if (!force) inflight = load;
	try {
		return await load;
	} finally {
		if (inflight === load) inflight = null;
	}
}

// Upsert the rank-scoring config row (used by the rank-sim "save weights" action).
// Same shape the bot's botConfig.setConfig writes; refreshes the local cache.
export async function saveRankConfig(config: RankScoringConfig): Promise<{ error: string | null }> {
	const clean = sanitize(config);
	const { error } = await db()
		.from('bot_config')
		.upsert(
			{
				config_name: RANK_CONFIG_NAME,
				config_group: RANK_CONFIG_GROUP,
				config_value: clean,
				description: 'Composite rank scoring: weights, score→rank thresholds, normalization caps.',
				updated_at: new Date().toISOString()
			},
			{ onConflict: 'config_name' }
		);
	if (error) return { error: error.message };
	cache = { value: clean, at: Date.now() };
	return { error: null };
}
