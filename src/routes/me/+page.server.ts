import { redirect, fail } from '@sveltejs/kit';
import { z } from 'zod';
import { db } from '$lib/server/db';
import { isValidClan, CLAN_OPTIONS } from '$lib/clans';
import { isValidAccountType, ACCOUNT_TYPES } from '$lib/accountTypes';
import { loadCardProfile } from '$lib/server/cardProfile';
import { isRsnTaken } from '$lib/server/users';
import { getPlayerRank, setPlayerRank } from '$lib/server/playerStats';
import { getRankConfig } from '$lib/server/rankConfig';
import { fetchPlayerRankInputs } from '$lib/server/rankData';
import { scorePlayer } from '$lib/server/rankScoring';
import { rankLabel } from '$lib/ranks';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) throw redirect(303, '/');

	const profile = await loadCardProfile(locals.user);
	const currentRank = await getPlayerRank(locals.user.discord_id, locals.user.rsn);

	return {
		user: locals.user,
		clanOptions: CLAN_OPTIONS,
		accountTypes: ACCOUNT_TYPES,
		currentRank,
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
			const { scores, rank } = scorePlayer(inputs, config);

			const write = await setPlayerRank(locals.user.discord_id, rsn, rank);
			if (!write.ok) {
				return fail(write.reason === 'no_player' ? 404 : 500, {
					rankError:
						write.reason === 'no_player'
							? 'No clan player record found for your RSN yet.'
							: 'Could not save your rank — try again later.'
				});
			}

			return {
				rankOk: true,
				rank,
				rankName: rankLabel(rank),
				composite: Math.round(scores.composite * 10000) / 10000,
				breakdown: {
					gear: Math.round(scores.gear * 1000) / 1000,
					ehb: Math.round(scores.ehb * 1000) / 1000,
					ca: Math.round(scores.ca * 1000) / 1000,
					time: Math.round(scores.time * 1000) / 1000,
					clog: Math.round(scores.clog * 1000) / 1000,
					level: Math.round(scores.level * 1000) / 1000
				},
				inputs: {
					ehb: inputs.ehb,
					totalLevel: inputs.totalLevel,
					gearPoints: inputs.gearPoints,
					clogFinished: inputs.clogFinished,
					clogAvailable: inputs.clogAvailable,
					monthsInClan: Math.round(inputs.monthsInClan * 10) / 10,
					caPoints: inputs.caPoints,
					templeAvailable: inputs.templeAvailable,
					wikisyncAvailable: inputs.wikisyncAvailable
				}
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
