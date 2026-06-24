import { redirect, fail } from '@sveltejs/kit';
import { z } from 'zod';
import { db } from '$lib/server/db';
import { isValidClan, CLAN_OPTIONS } from '$lib/clans';
import { isValidAccountType, ACCOUNT_TYPES } from '$lib/accountTypes';
import { loadCardProfile } from '$lib/server/cardProfile';
import { isRsnTaken } from '$lib/server/users';
import { getPlayerRank, setPlayerRank } from '$lib/server/playerStats';
import { getRankConfig, type RankScoringConfig } from '$lib/server/rankConfig';
import { fetchPlayerRankInputs, type GearDetail, type CADetail } from '$lib/server/rankData';
import {
	scorePlayer,
	computeScores,
	determineProjectedRank,
	describeComposite,
	getGearCatalog,
	GEAR_SCORE_CAP,
	CA_MAX_POINTS
} from '$lib/server/rankScoring';
import type { RankValue } from '$lib/ranks';
import type { Actions, PageServerLoad } from './$types';

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

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) throw redirect(303, '/');

	const profile = await loadCardProfile(locals.user);
	const currentRank = await getPlayerRank(locals.user.discord_id, locals.user.rsn);

	// Rank tab: render from the member's cached vs_rank_sim row (recomputed with the
	// live config). Null until they "Check my rank" or an admin refresh fetches them.
	let rankBreakdown: ReturnType<typeof buildRankBreakdown> | null = null;
	if (locals.user.rsn) {
		const [config, { data: simRow }] = await Promise.all([
			getRankConfig(),
			db().from('vs_rank_sim').select(SIM_ROW_COLUMNS).ilike('rsn', locals.user.rsn).maybeSingle()
		]);
		if (simRow) rankBreakdown = buildRankBreakdown(simRow as RankSimRow, config);
	}

	return {
		user: locals.user,
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
};

const RSN_REGEX = /^[A-Za-z0-9 _-]{1,12}$/;

const profileSchema = z.object({
	rsn: z
		.string()
		.trim()
		.regex(RSN_REGEX, 'RSN must be 1-12 chars (letters, numbers, space, _ or -)'),
	clan_allegiance: z.string().refine(isValidClan, 'Pick a clan'),
	account_type: z.string().refine(isValidAccountType, 'Pick your account type')
});

// Per-user cooldown for the "Check my rank" action — it hits three external APIs
// (WOM + TempleOSRS + WikiSync), so cap it to once per minute per user. In-memory is
// fine: a single adapter-node process, and a missed cooldown across a restart is harmless.
const lastRankCheck = new Map<string, number>();
const RANK_CHECK_COOLDOWN_MS = 60_000;

export const actions: Actions = {
	// Fetch the signed-in player's live data, compute their composite rank with the
	// current rank_scoring config, and write players.rank (the bot mirrors it to Discord).
	checkRank: async ({ locals }) => {
		if (!locals.user) throw redirect(303, '/');
		const rsn = locals.user.rsn;
		if (!rsn) return fail(400, { rankError: 'Set your RSN on your profile first.' });

		const last = lastRankCheck.get(locals.user.id) ?? 0;
		const wait = RANK_CHECK_COOLDOWN_MS - (Date.now() - last);
		if (wait > 0) {
			return fail(429, { rankError: `Please wait ${Math.ceil(wait / 1000)}s before checking again.` });
		}
		lastRankCheck.set(locals.user.id, Date.now());

		try {
			const [config, inputs] = await Promise.all([getRankConfig(), fetchPlayerRankInputs(rsn)]);
			const { rank } = scorePlayer(inputs, config);

			// Cache the freshly-fetched inputs + piece-level detail in vs_rank_sim (same
			// shape the admin rank-sim writes). The page load re-runs after this action and
			// rebuilds the Rank tab breakdown from this row — one rendering path.
			const { error: cacheErr } = await db()
				.from('vs_rank_sim')
				.upsert(
					{
						rsn: inputs.rsn,
						wom_id: inputs.womId,
						ehb: inputs.ehb,
						total_level: inputs.totalLevel,
						gear_points: inputs.gearPoints,
						clog_finished: inputs.clogFinished,
						clog_available: inputs.clogAvailable,
						months_in_clan: Math.round(inputs.monthsInClan * 100) / 100,
						ca_points: inputs.caPoints,
						temple_available: inputs.templeAvailable,
						wikisync_available: inputs.wikisyncAvailable,
						ca_tier: inputs.caTier,
						gear_detail: inputs.gearDetail,
						ca_detail: inputs.caDetail,
						fetched_at: new Date().toISOString()
					},
					{ onConflict: 'rsn' }
				);
			if (cacheErr) {
				lastRankCheck.delete(locals.user.id);
				return fail(500, { rankError: 'Could not save your rank breakdown — try again later.' });
			}

			// If a stats source was down (Temple/WikiSync), its component degrades to 0 and
			// the composite is artificially low. Show the breakdown, but DON'T persist the
			// rank — the bot mirrors players.rank to a Discord role, so writing a degraded
			// score off a transient 429/outage could wrongly demote the member.
			if (!inputs.templeAvailable || !inputs.wikisyncAvailable) {
				return {
					rankOk: true,
					rankSaved: false,
					rankNote:
						'Computed from partial data — a stats source (Temple/WikiSync) was unavailable, so your clan rank was not updated to avoid an inaccurate change. Try again shortly.'
				};
			}

			// Mirror the computed rank to the clan player record (the bot syncs it to
			// Discord). A missing player record isn't fatal — the breakdown still renders.
			const write = await setPlayerRank(locals.user.discord_id, rsn, rank);
			return {
				rankOk: true,
				rankSaved: write.ok,
				rankNote: write.ok
					? null
					: write.reason === 'no_player'
						? 'Computed from your latest data, but no clan player record was found to save your rank to yet.'
						: 'Your breakdown was updated, but saving your clan rank failed — try again later.'
			};
		} catch (e) {
			lastRankCheck.delete(locals.user.id); // let them retry a transient failure now
			return fail(500, { rankError: e instanceof Error ? e.message : 'Rank check failed.' });
		}
	},

	default: async ({ request, locals }) => {
		if (!locals.user) throw redirect(303, '/');

		const form = await request.formData();
		const parsed = profileSchema.safeParse({
			rsn: form.get('rsn'),
			clan_allegiance: form.get('clan_allegiance'),
			account_type: form.get('account_type')
		});

		if (!parsed.success) {
			return fail(400, {
				error: parsed.error.issues[0]?.message ?? 'Invalid input'
			});
		}

		const { rsn, clan_allegiance, account_type } = parsed.data;
		const supabase = db();

		if (await isRsnTaken(rsn, locals.user.id)) {
			return fail(409, { error: 'That RSN is already registered to another account' });
		}

		const { error } = await supabase
			.from('vs_users')
			.update({ rsn, clan_allegiance, account_type })
			.eq('id', locals.user.id);

		if (error) return fail(500, { error: error.message });

		return { success: true };
	}
};
