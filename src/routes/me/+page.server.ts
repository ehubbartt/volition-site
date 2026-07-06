import { fail, redirect } from '@sveltejs/kit';
import { z } from 'zod';
import { db } from '$lib/server/db';
import { isValidClan } from '$lib/clans';
import { isValidAccountType } from '$lib/accountTypes';
import { isRsnTaken } from '$lib/server/users';
import { setPlayerRank } from '$lib/server/playerStats';
import { getRankConfig } from '$lib/server/rankConfig';
import { fetchPlayerRankInputs } from '$lib/server/rankData';
import { scorePlayer } from '$lib/server/rankScoring';
import type { Actions } from './$types';

// ACTIONS ONLY — this page has no server load. Its data comes from /api/me
// (built in $lib/server/meData.ts) via the universal load in +page.ts, so
// navigating to /me never waits on the server.

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
