import { redirect, error, fail } from '@sveltejs/kit';
import { db, selectAll } from '$lib/server/db';
import { isAdmin } from '$lib/server/auth';
import {
	getRankConfig,
	saveRankConfig,
	DEFAULT_RANK_CONFIG,
	type RankScoringConfig
} from '$lib/server/rankConfig';
import { computeScores, determineProjectedRank } from '$lib/server/rankScoring';
import {
	fetchClanRoster,
	fetchPlayerTotalLevel,
	fetchTempleCollectionLog,
	fetchWikiSyncCA,
	fetchPlayerBossKills,
	monthsBetween
} from '$lib/server/rankData';
import { calculateGearPoints, calculateCAPoints } from '$lib/server/rankScoring';
import { usesIronmanEhb, computeIronmanEhb } from '$lib/server/rankScoring/ehb';
import { getApprovedGearNamesByRsn } from '$lib/server/rankClaims';
import { setPlayerRank } from '$lib/server/playerStats';
import { microCached } from '$lib/server/microCache';
import { RANK_ORDER, RANK_LABEL, rankIndex, toRankValue, type RankValue } from '$lib/ranks';
import type { Actions, PageServerLoad } from './$types';

// Admin rank-distribution simulator. Mirrors voli-disc-bot/scripts/simulateRanks.js as
// a web tool: REFRESH pulls clan data into a cached `vs_rank_sim` table (batched, since
// it hits WOM + Temple + WikiSync per player), then RECALC re-scores the whole clan
// INSTANTLY from that cache as you tune the weights/thresholds/caps — so you can dial in
// the spread before saving the config live (bot_config 'rank_scoring') or APPLYing the
// projected ranks to players.rank. Admin-gated, like /admin/crate-sim.

const REFRESH_BATCH = 6; // players fetched per request (bounds request time)
// WOM's anonymous rate budget is ~20 req/min and each player costs one WOM call
// (Temple/WikiSync have their own, laxer limits) — 3s spacing keeps a full
// auto-chained sweep at ~20/min so WOM stops 429ing mid-run.
const PER_PLAYER_DELAY_MS = 3000;
// The bulk roster call is heavy; cache it across the run's batches (and across
// admins) instead of re-fetching it every ~30s. Identity-independent → microCache.
const ROSTER_TTL_MS = 10 * 60_000;

interface SimRow {
	rsn: string;
	wom_id: number | null;
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
	fetched_at: string | null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// One WOM group call per ROSTER_TTL_MS, shared by refresh batches and the live
// comparison. Throw INSIDE the cached fn so an empty/failed roster is never cached.
async function getRosterCached() {
	return microCached('wom:roster', ROSTER_TTL_MS, async () => {
		const r = await fetchClanRoster();
		if (Object.keys(r).length === 0) throw new Error('empty roster');
		return r;
	}).catch(() => null);
}

async function readSimRows(): Promise<SimRow[]> {
	return selectAll<SimRow>(
		'vs_rank_sim',
		'rsn, wom_id, ehb, total_level, gear_points, clog_finished, clog_available, months_in_clan, ca_points, temple_available, wikisync_available, ca_tier, fetched_at'
	);
}

// Map lowercase rsn → the player's CURRENT stored rank (players.rank), for the
// current-vs-projected distribution comparison.
async function readCurrentRanks(): Promise<Map<string, string | null>> {
	const rows = await selectAll<{ rsn: string | null; rank: string | null }>('players', 'rsn, rank');
	const m = new Map<string, string | null>();
	for (const r of rows) if (r.rsn) m.set(r.rsn.toLowerCase(), r.rank);
	return m;
}

// Map lowercase rsn → the member's site account_type (vs_users), so the refresh can
// re-derive EHB on iron rates for group-ironman accounts (rankScoring/ehb.ts).
async function readAccountTypes(): Promise<Map<string, string | null>> {
	const rows = await selectAll<{ rsn: string | null; account_type: string | null }>('vs_users', 'rsn, account_type');
	const m = new Map<string, string | null>();
	for (const r of rows) if (r.rsn) m.set(r.rsn.toLowerCase(), r.account_type);
	return m;
}

interface Scored {
	rsn: string;
	current: RankValue | null;
	projected: RankValue;
	composite: number;
	scores: ReturnType<typeof computeScores>;
	row: SimRow;
}

// Re-score every cached row with `config` and assemble the same summaries the bot
// script prints (distribution, component averages, histogram, notable changes).
function buildSummary(
	rows: SimRow[],
	config: RankScoringConfig,
	current: Map<string, string | null>,
	opts?: { excludeNoTemple?: boolean }
) {
	// Players without Temple data score 0 on gear + clog through no fault of their
	// own (private/unsynced log), which drags the distribution and averages down.
	// The exclude toggle drops them from the whole simulation view.
	const excludedNoTemple = opts?.excludeNoTemple
		? rows.filter((r) => !r.temple_available).length
		: 0;
	if (opts?.excludeNoTemple) rows = rows.filter((r) => r.temple_available);

	const scored: Scored[] = rows.map((row) => {
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
		const cur = current.get(row.rsn.toLowerCase()) ?? null;
		const curNorm = toRankValue(cur);
		return {
			rsn: row.rsn,
			current: curNorm,
			projected: determineProjectedRank(scores.composite, config),
			composite: scores.composite,
			scores,
			row
		};
	});

	const total = scored.length;
	const currentDist: Record<string, number> = {};
	const projectedDist: Record<string, number> = {};
	for (const s of scored) {
		if (s.current) currentDist[s.current] = (currentDist[s.current] || 0) + 1;
		projectedDist[s.projected] = (projectedDist[s.projected] || 0) + 1;
	}

	const distribution = RANK_ORDER.map((rank) => {
		const curr = currentDist[rank] || 0;
		const proj = projectedDist[rank] || 0;
		return {
			rank,
			label: RANK_LABEL[rank],
			current: curr,
			projected: proj,
			currentPct: total ? (curr / total) * 100 : 0,
			projectedPct: total ? (proj / total) * 100 : 0,
			diff: proj - curr
		};
	});

	const avg = (key: keyof ReturnType<typeof computeScores>) =>
		total ? scored.reduce((s, r) => s + r.scores[key], 0) / total : 0;
	const componentAverages = {
		gear: avg('gear'),
		ehb: avg('ehb'),
		ca: avg('ca'),
		time: avg('time'),
		clog: avg('clog'),
		level: avg('level'),
		composite: avg('composite')
	};

	// Notable moves (projected vs current rank), biggest deltas first.
	const changes = scored
		.filter((s) => s.current && s.current !== s.projected)
		.map((s) => ({
			rsn: s.rsn,
			from: s.current as RankValue,
			to: s.projected,
			delta: rankIndex(s.projected) - rankIndex(s.current)
		}))
		.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
	const upgrades = changes.filter((c) => c.delta > 0).slice(0, 15);
	const downgrades = changes.filter((c) => c.delta < 0).slice(0, 15);

	// Full player table, highest composite first.
	const players = scored
		.slice()
		.sort((a, b) => b.composite - a.composite)
		.map((s) => ({
			rsn: s.rsn,
			current: s.current,
			projected: s.projected,
			composite: Math.round(s.composite * 10000) / 10000,
			ehb: s.row.ehb,
			gearPoints: s.row.gear_points,
			caPoints: s.row.ca_points,
			clogFinished: s.row.clog_finished,
			totalLevel: s.row.total_level,
			months: Math.round(s.row.months_in_clan * 10) / 10,
			templeAvailable: s.row.temple_available,
			wikisyncAvailable: s.row.wikisync_available
		}));

	return {
		total,
		distribution,
		componentAverages,
		upgrades,
		downgrades,
		players,
		excludedNoTemple
	};
}

// Target population share per rank (low → high) for "Suggest right-skewed thresholds":
// a right-skewed, still-roughly-bell shape — mode at Gold/Mithril, steadily decaying
// tail so the top ranks stay rare. Must line up with RANK_ORDER and sum to 1.
const SKEW_TARGET_SHARE = [0.06, 0.09, 0.12, 0.14, 0.14, 0.11, 0.09, 0.07, 0.06, 0.05, 0.04, 0.02, 0.01];

// Derive score→rank thresholds that would place the given composite scores into the
// SKEW_TARGET_SHARE distribution: each rank's floor is the score quantile at the
// cumulative share below it (midpoint between the straddling players, so small score
// nudges don't flip anyone), rounded to a clean 2-decimal value. Strictly increasing
// so tied scores can't collapse ranks.
function suggestSkewedThresholds(composites: number[]): { womRole: RankValue; scoreMin: number }[] {
	const sorted = [...composites].sort((a, b) => a - b);
	const n = sorted.length;
	const out: { womRole: RankValue; scoreMin: number }[] = [];
	let cum = 0;
	let prev = -1;
	RANK_ORDER.forEach((womRole, i) => {
		let scoreMin = 0; // bronze: everyone qualifies
		if (i > 0) {
			const k = Math.min(n - 1, Math.max(1, Math.round(cum * n)));
			const mid = (sorted[k - 1] + sorted[k]) / 2;
			scoreMin = Math.round(mid * 100) / 100;
		}
		scoreMin = Math.min(0.99, Math.max(scoreMin, prev + (i > 0 ? 0.01 : 0)));
		scoreMin = Math.round(scoreMin * 100) / 100;
		prev = scoreMin;
		cum += SKEW_TARGET_SHARE[i];
		out.push({ womRole, scoreMin });
	});
	return out;
}

// Build a RankScoringConfig from posted form fields, falling back to `base` per field.
function parseConfigFromForm(form: FormData, base: RankScoringConfig): RankScoringConfig {
	const num = (key: string, fallback: number) => {
		const v = Number(form.get(key));
		return Number.isFinite(v) ? v : fallback;
	};
	return {
		weights: {
			gear: num('w_gear', base.weights.gear),
			ehb: num('w_ehb', base.weights.ehb),
			ca: num('w_ca', base.weights.ca),
			time: num('w_time', base.weights.time),
			clog: num('w_clog', base.weights.clog),
			level: num('w_level', base.weights.level)
		},
		caps: {
			ehb: num('c_ehb', base.caps.ehb),
			months: num('c_months', base.caps.months),
			clog: num('c_clog', base.caps.clog),
			levelMin: num('c_levelMin', base.caps.levelMin),
			levelRange: num('c_levelRange', base.caps.levelRange),
			gear: num('c_gear', base.caps.gear)
		},
		curves: {
			gear: num('curve_gear', base.curves.gear),
			ehb: num('curve_ehb', base.curves.ehb)
		},
		thresholds: RANK_ORDER.map((womRole) => ({
			womRole,
			scoreMin: num(
				`t_${womRole}`,
				base.thresholds.find((t) => t.womRole === womRole)?.scoreMin ?? 0
			)
		}))
	};
}

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) throw redirect(303, '/');
	if (!isAdmin(locals.user)) throw error(403, 'Not allowed');

	const config = await getRankConfig(true);
	const rows = await readSimRows();
	const current = await readCurrentRanks();
	const lastFetched = rows.reduce<string | null>(
		(latest, r) => (r.fetched_at && (!latest || r.fetched_at > latest) ? r.fetched_at : latest),
		null
	);

	return {
		config,
		defaults: DEFAULT_RANK_CONFIG,
		rankOrder: RANK_ORDER,
		rankLabels: RANK_LABEL,
		cachedCount: rows.length,
		lastFetched,
		summary: buildSummary(rows, config, current)
	};
};

export const actions: Actions = {
	// Pull the next batch of clan members' raw data into vs_rank_sim. Resumable: each
	// request fetches the REFRESH_BATCH stalest (or never-fetched) roster members.
	// The page auto-chains batches: it stamps a `since` when a run starts, we only
	// consider members not yet fetched in THIS pass, and `remaining` in the response
	// tells the client whether to submit again — so one click sweeps the whole clan
	// while every batch keeps the per-player politeness delay.
	refresh: async ({ locals, request }) => {
		if (!locals.user || !isAdmin(locals.user)) throw error(403, 'Not allowed');

		const form = await request.formData();
		const since = (form.get('since') ?? '').toString();
		// Skip roster members who already have a Temple-complete cached row — only fetch
		// the ones still missing collection-log data (new members, or a prior run where
		// Temple was private/down). Makes a top-up sweep fast instead of re-fetching everyone.
		const onlyMissing = form.get('onlyMissing') === '1';

		// Cached across batches: one WOM group call per run instead of one per batch.
		const roster = await getRosterCached();
		if (!roster) {
			// refreshRetryable tells the auto-run to back off and try again rather
			// than aborting the sweep on a transient WOM rate-limit/outage.
			return fail(502, {
				refreshError: 'WOM clan roster unavailable (likely rate-limited).',
				refreshRetryable: true
			});
		}
		const rosterEntries = Object.values(roster);

		const existing = await readSimRows();
		const fetchedAt = new Map(existing.map((r) => [r.rsn.toLowerCase(), r.fetched_at]));
		// Members who already have collection-log data — skipped when onlyMissing is set.
		const hasTemple = new Set(
			existing.filter((r) => r.temple_available).map((r) => r.rsn.toLowerCase())
		);

		// This pass's pending set: members whose last fetch predates the run start
		// (never-fetched sorts as '' — always pending). Without `since` (manual single
		// batch), everyone is eligible and the stalest-first order picks the batch. When
		// onlyMissing is set, members who already have Temple data are dropped entirely.
		const pending = (
			since
				? rosterEntries.filter((e) => (fetchedAt.get(e.rsn.toLowerCase()) ?? '') < since)
				: rosterEntries.slice()
		).filter((e) => !onlyMissing || !hasTemple.has(e.rsn.toLowerCase()));

		// Stalest first: never-fetched (null) before oldest timestamp.
		const worklist = pending
			.sort((a, b) => {
				const fa = fetchedAt.get(a.rsn.toLowerCase()) ?? '';
				const fb = fetchedAt.get(b.rsn.toLowerCase()) ?? '';
				return fa < fb ? -1 : fa > fb ? 1 : 0;
			})
			.slice(0, REFRESH_BATCH);

		const sb = db();
		// Approved manual gear claims (untrackable items) merge into the gear calc,
		// same as /me's checkRank. One bulk read per batch, keyed by lowercase RSN.
		const manualGearByRsn = await getApprovedGearNamesByRsn();
		// Site account types, so GIM members get iron-rate EHB (rankScoring/ehb.ts).
		const accountTypeByRsn = await readAccountTypes();
		let processed = 0;
		for (const entry of worklist) {
			// GIM accounts: re-derive EHB from boss KCs on iron rates (fetched in parallel).
			const iron = usesIronmanEhb(accountTypeByRsn.get(entry.rsn.toLowerCase()));
			const [totalLevel, temple, ca, bossKills] = await Promise.all([
				fetchPlayerTotalLevel(entry.rsn),
				fetchTempleCollectionLog(entry.rsn),
				fetchWikiSyncCA(entry.rsn),
				iron ? fetchPlayerBossKills(entry.rsn) : Promise.resolve(null)
			]);
			const gear = calculateGearPoints(temple?.items, manualGearByRsn.get(entry.rsn.toLowerCase()));
			const caResult = calculateCAPoints(ca);
			// Keep WOM's EHB if the iron boss snapshot didn't come back (outage), rather
			// than zeroing a GIM's EHB component.
			const ehb = iron && bossKills ? Math.round(computeIronmanEhb(bossKills)) : entry.ehb;

			const { error: upErr } = await sb.from('vs_rank_sim').upsert(
				{
					rsn: entry.rsn,
					wom_id: entry.womId,
					ehb,
					total_level: totalLevel,
					gear_points: gear.gearPoints,
					clog_finished: temple?.finished ?? 0,
					clog_available: temple?.available ?? 0,
					months_in_clan: Math.round(monthsBetween(entry.clanJoinedAt) * 100) / 100,
					ca_points: caResult.caPoints,
					temple_available: temple != null,
					wikisync_available: ca != null,
					ca_tier: caResult.highestTier,
					gear_detail: { matchedItems: gear.matchedItems, missedItems: gear.missedItems, partials: gear.partials },
					ca_detail: {
						tasksCompleted: caResult.tasksCompleted,
						wikiPoints: caResult.wikiPoints,
						highestTier: caResult.highestTier
					},
					fetched_at: new Date().toISOString()
				},
				{ onConflict: 'rsn' }
			);
			if (upErr) return fail(500, { refreshError: `DB write failed: ${upErr.message}` });
			processed++;
			if (processed < worklist.length) await sleep(PER_PLAYER_DELAY_MS);
		}

		const cachedNow = new Set(existing.map((r) => r.rsn.toLowerCase()));
		for (const e of worklist) cachedNow.add(e.rsn.toLowerCase());

		return {
			refreshOk: true,
			processed,
			cachedCount: cachedNow.size,
			rosterSize: rosterEntries.length,
			// How many of this pass's pending members are still unfetched — >0 tells
			// the page to auto-submit the next batch (0 without `since`: single-batch).
			remaining: since ? Math.max(0, pending.length - processed) : 0
		};
	},

	// Re-score the cached clan with the posted weights/thresholds/caps (INSTANT — no
	// external calls). Pass save=1 to also persist them as the live rank_scoring config.
	recalc: async ({ locals, request }) => {
		if (!locals.user || !isAdmin(locals.user)) throw error(403, 'Not allowed');

		const form = await request.formData();
		const base = await getRankConfig(true);
		const config = parseConfigFromForm(form, base);

		let saved = false;
		let saveError: string | null = null;
		if (form.get('save') === '1') {
			const res = await saveRankConfig(config);
			if (res.error) saveError = res.error;
			else saved = true;
		}

		const [rows, current] = await Promise.all([readSimRows(), readCurrentRanks()]);
		const excludeNoTemple = form.get('excludeNoTemple') === '1';
		return {
			recalcOk: true,
			saved,
			saveError,
			config,
			excludeNoTemple, // echoed so the checkbox stays put across recalcs
			summary: buildSummary(rows, config, current, { excludeNoTemple })
		};
	},

	// Compute right-skewed thresholds from the cached players' ACTUAL composite scores
	// (quantiles of SKEW_TARGET_SHARE, using the form's weights/caps) and return them
	// like a recalc — the form repopulates and the chart previews the shape. Nothing is
	// saved; the admin reviews and uses "Save as live config" to persist.
	suggest: async ({ locals, request }) => {
		if (!locals.user || !isAdmin(locals.user)) throw error(403, 'Not allowed');

		const form = await request.formData();
		const base = await getRankConfig(true);
		const formConfig = parseConfigFromForm(form, base);
		const excludeNoTemple = form.get('excludeNoTemple') === '1';

		const [rows, current] = await Promise.all([readSimRows(), readCurrentRanks()]);
		const scoreRows = excludeNoTemple ? rows.filter((r) => r.temple_available) : rows;
		if (scoreRows.length < 2) {
			return fail(400, {
				suggestError: 'Not enough cached players to suggest thresholds — refresh first.'
			});
		}

		const composites = scoreRows.map(
			(row) =>
				computeScores(
					{
						ehb: row.ehb,
						totalLevel: row.total_level,
						gearPoints: row.gear_points,
						clogFinished: row.clog_finished,
						clogAvailable: row.clog_available,
						monthsInClan: row.months_in_clan,
						caPoints: row.ca_points
					},
					formConfig
				).composite
		);

		const config: RankScoringConfig = {
			...formConfig,
			thresholds: suggestSkewedThresholds(composites)
		};

		return {
			suggestOk: true,
			suggestedFrom: scoreRows.length,
			config,
			excludeNoTemple,
			summary: buildSummary(rows, config, current, { excludeNoTemple })
		};
	},

	// Live comparison: the new system's projected ranks (cached inputs + SAVED config)
	// vs the ranks members hold IN GAME right now (their WOM group role — the group is
	// synced from the clan, so rank-named roles are the in-game rank; staff roles like
	// 'owner' don't map and are counted separately). Also reports how many stored
	// players.rank values already match the projection, i.e. how applied the new
	// system already is.
	compare: async ({ locals }) => {
		if (!locals.user || !isAdmin(locals.user)) throw error(403, 'Not allowed');

		const roster = await getRosterCached();
		if (!roster) {
			return fail(502, { compareError: 'WOM clan roster unavailable (likely rate-limited) — try again shortly.' });
		}

		const config = await getRankConfig(true);
		const [rows, current] = await Promise.all([readSimRows(), readCurrentRanks()]);
		const simByRsn = new Map(rows.map((r) => [r.rsn.toLowerCase(), r]));

		let up = 0;
		let down = 0;
		let same = 0;
		let unmappedRole = 0; // staff/unrecognized WOM roles (owner, deputy_owner, …)
		let notCached = 0; // roster members with no vs_rank_sim row yet
		let noTemple = 0; // cached but no Temple data — gear/clog score 0, would skew everything
		let storedMatches = 0; // players.rank already equals the projection
		let storedCompared = 0;
		const deltaHist = new Map<number, number>();
		const womDist: Record<string, number> = {};
		const projectedDist: Record<string, number> = {};
		const players: {
			rsn: string;
			womRole: string | null;
			womRank: RankValue | null;
			projected: RankValue;
			stored: RankValue | null;
			delta: number | null;
			composite: number;
		}[] = [];

		for (const e of Object.values(roster)) {
			const row = simByRsn.get(e.rsn.toLowerCase());
			if (!row) {
				notCached++;
				continue;
			}
			// No Temple data → gear + clog score 0 through no fault of the player's, which
			// would read as a mass demotion. Excluded outright (counted for coverage).
			if (!row.temple_available) {
				noTemple++;
				continue;
			}
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
			const projected = determineProjectedRank(scores.composite, config);
			const stored = toRankValue(current.get(e.rsn.toLowerCase()) ?? null);
			if (stored) {
				storedCompared++;
				if (stored === projected) storedMatches++;
			}
			const womRank = toRankValue(e.womRole);
			let delta: number | null = null;
			if (womRank) {
				delta = rankIndex(projected) - rankIndex(womRank);
				if (delta > 0) up++;
				else if (delta < 0) down++;
				else same++;
				deltaHist.set(delta, (deltaHist.get(delta) ?? 0) + 1);
				// Both distributions cover the SAME population (compared members only) so
				// the two histograms are directly comparable.
				womDist[womRank] = (womDist[womRank] ?? 0) + 1;
				projectedDist[projected] = (projectedDist[projected] ?? 0) + 1;
			} else {
				unmappedRole++;
			}
			players.push({
				rsn: e.rsn,
				womRole: e.womRole,
				womRank,
				projected,
				stored,
				delta,
				composite: Math.round(scores.composite * 10000) / 10000
			});
		}

		// Biggest movers first; unmapped roles sink to the bottom.
		players.sort((a, b) => Math.abs(b.delta ?? -1) - Math.abs(a.delta ?? -1) || (b.delta ?? 0) - (a.delta ?? 0));
		const compared = up + down + same;
		const avgAbsDelta = compared
			? players.reduce((s, p) => s + Math.abs(p.delta ?? 0), 0) / compared
			: 0;

		return {
			compareOk: true,
			comparison: {
				rosterSize: Object.keys(roster).length,
				compared,
				up,
				down,
				same,
				unmappedRole,
				notCached,
				noTemple,
				storedMatches,
				storedCompared,
				avgAbsDelta: Math.round(avgAbsDelta * 100) / 100,
				deltaHist: [...deltaHist.entries()].sort((a, b) => a[0] - b[0]).map(([delta, count]) => ({ delta, count })),
				// Side-by-side rank distributions over the compared members.
				dist: RANK_ORDER.map((rank) => ({
					rank,
					label: RANK_LABEL[rank],
					inGame: womDist[rank] ?? 0,
					projected: projectedDist[rank] ?? 0
				})),
				players
			}
		};
	},

	// Write the projected ranks (using the SAVED live config) to players.rank in bulk.
	apply: async ({ locals }) => {
		if (!locals.user || !isAdmin(locals.user)) throw error(403, 'Not allowed');

		const config = await getRankConfig(true);
		const rows = await readSimRows();

		let updated = 0;
		let missing = 0;
		for (const row of rows) {
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
			const rank = determineProjectedRank(scores.composite, config);
			const res = await setPlayerRank(null, row.rsn, rank);
			if (res.ok) updated++;
			else missing++;
		}

		return { applyOk: true, updated, missing };
	}
};
