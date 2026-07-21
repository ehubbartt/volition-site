import { memberEndpoint } from '$lib/server/apiEndpoint';
import { db } from '$lib/server/db';
import { rsnExactPattern } from '$lib/server/users';
import { getRankConfig } from '$lib/server/rankConfig';
import { getEhbOverrides } from '$lib/server/ehbOverrides';
import { buildRankAdvice } from '$lib/server/rankScoring/rankAdvice';
import type { RequestHandler } from './$types';

// "How do I rank up?" advice for the signed-in member. Reads their most recent cached
// vs_rank_sim row (populated by /me "Check my rank" or the admin rank-sim refresh) and
// the live config, then prices the fastest paths to their next rank. Lazy: the /me Rank
// tab fetches this only when the member presses the advisor button. Returns
// { available:false } when they've never checked their rank.

const COLS =
	'ehb, total_level, gear_points, clog_finished, clog_available, months_in_clan, ca_points, gear_detail, ca_detail, fetched_at';

interface GearDetail {
	matchedItems?: { name: string }[];
	partials?: { name: string; missing: string[] }[];
}
interface CADetail {
	wikiPoints?: number;
}

export const GET: RequestHandler = memberEndpoint(async (user) => {
	if (!user.rsn) return { available: false as const, reason: 'no_rsn' };

	const [config, overrides, { data: rows }] = await Promise.all([
		getRankConfig(),
		getEhbOverrides(),
		db()
			.from('vs_rank_sim')
			.select(COLS)
			.ilike('rsn', rsnExactPattern(user.rsn))
			.order('fetched_at', { ascending: false })
			.limit(1)
	]);

	const row = rows?.[0] as
		| {
				ehb: number;
				total_level: number | null;
				gear_points: number;
				clog_finished: number;
				clog_available: number;
				months_in_clan: number;
				ca_points: number;
				gear_detail: GearDetail | null;
				ca_detail: CADetail | null;
				fetched_at: string | null;
		  }
		| undefined;
	if (!row) return { available: false as const, reason: 'not_checked' };

	const advice = buildRankAdvice(
		{
			ehb: row.ehb ?? 0,
			totalLevel: row.total_level,
			gearPoints: row.gear_points ?? 0,
			clogFinished: row.clog_finished ?? 0,
			clogAvailable: row.clog_available ?? 0,
			monthsInClan: row.months_in_clan ?? 0,
			caPoints: row.ca_points ?? 0,
			caWikiPoints: row.ca_detail?.wikiPoints ?? 0,
			gearMatched: (row.gear_detail?.matchedItems ?? []).map((m) => m.name),
			gearPartials: (row.gear_detail?.partials ?? []).map((p) => ({ name: p.name, missing: p.missing }))
		},
		config,
		overrides
	);
	return { ...advice, fetchedAt: row.fetched_at };
});
