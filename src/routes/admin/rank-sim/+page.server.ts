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
	monthsBetween
} from '$lib/server/rankData';
import { calculateGearPoints, calculateCAPoints } from '$lib/server/rankScoring';
import { setPlayerRank } from '$lib/server/playerStats';
import { RANK_ORDER, RANK_LABEL, rankIndex, toRankValue, type RankValue } from '$lib/ranks';
import type { Actions, PageServerLoad } from './$types';

// Admin rank-distribution simulator. Mirrors voli-disc-bot/scripts/simulateRanks.js as
// a web tool: REFRESH pulls clan data into a cached `vs_rank_sim` table (batched, since
// it hits WOM + Temple + WikiSync per player), then RECALC re-scores the whole clan
// INSTANTLY from that cache as you tune the weights/thresholds/caps — so you can dial in
// the spread before saving the config live (bot_config 'rank_scoring') or APPLYing the
// projected ranks to players.rank. Admin-gated, like /admin/crate-sim.

const REFRESH_BATCH = 8; // players fetched per "refresh" click (bounds request time)
const PER_PLAYER_DELAY_MS = 1200; // be polite to the external APIs between players

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
function buildSummary(rows: SimRow[], config: RankScoringConfig, current: Map<string, string | null>) {
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

	// 20-bucket composite histogram (0.00–1.00).
	const buckets = new Array(20).fill(0) as number[];
	for (const s of scored) buckets[Math.min(19, Math.floor(s.composite * 20))]++;
	const histogram = buckets.map((count, i) => ({
		lo: i * 0.05,
		hi: (i + 1) * 0.05,
		count
	}));

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

	return { total, distribution, componentAverages, histogram, upgrades, downgrades, players };
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
			levelRange: num('c_levelRange', base.caps.levelRange)
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
	// click fetches the REFRESH_BATCH stalest (or never-fetched) roster members.
	refresh: async ({ locals }) => {
		if (!locals.user || !isAdmin(locals.user)) throw error(403, 'Not allowed');

		const roster = await fetchClanRoster();
		const rosterEntries = Object.values(roster);
		if (rosterEntries.length === 0) {
			return fail(502, { refreshError: 'WOM clan roster unavailable — try again shortly.' });
		}

		const existing = await readSimRows();
		const fetchedAt = new Map(existing.map((r) => [r.rsn.toLowerCase(), r.fetched_at]));

		// Stalest first: never-fetched (null) before oldest timestamp.
		const worklist = rosterEntries
			.slice()
			.sort((a, b) => {
				const fa = fetchedAt.get(a.rsn.toLowerCase()) ?? '';
				const fb = fetchedAt.get(b.rsn.toLowerCase()) ?? '';
				return fa < fb ? -1 : fa > fb ? 1 : 0;
			})
			.slice(0, REFRESH_BATCH);

		const sb = db();
		let processed = 0;
		for (const entry of worklist) {
			const [totalLevel, temple, ca] = await Promise.all([
				fetchPlayerTotalLevel(entry.rsn),
				fetchTempleCollectionLog(entry.rsn),
				fetchWikiSyncCA(entry.rsn)
			]);
			const gear = calculateGearPoints(temple?.items);
			const caResult = calculateCAPoints(ca);

			const { error: upErr } = await sb.from('vs_rank_sim').upsert(
				{
					rsn: entry.rsn,
					wom_id: entry.womId,
					ehb: entry.ehb,
					total_level: totalLevel,
					gear_points: gear.gearPoints,
					clog_finished: temple?.finished ?? 0,
					clog_available: temple?.available ?? 0,
					months_in_clan: Math.round(monthsBetween(entry.clanJoinedAt) * 100) / 100,
					ca_points: caResult.caPoints,
					temple_available: temple != null,
					wikisync_available: ca != null,
					ca_tier: caResult.highestTier,
					gear_detail: { matchedItems: gear.matchedItems, missedItems: gear.missedItems },
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
			rosterSize: rosterEntries.length
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
		return {
			recalcOk: true,
			saved,
			saveError,
			config,
			summary: buildSummary(rows, config, current)
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
