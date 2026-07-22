// SERVER-ONLY: run one player's live rank check and persist it — the shared core behind
// BOTH the member's own /me "Check my rank" and the admin single-player re-check on
// /admin/rank-sim. Keeping it in one place means the two paths score, cache, and persist
// identically (same vs_rank_sim row, same degraded-data guard, same players.rank write).
//
// It does NOT own policy that differs per caller — cooldowns (per-user on /me) and the
// rank-up celebration live at the call site; this helper just fetches, caches, and saves.

import { db } from './db';
import { rsnExactPattern } from './users';
import { getApprovedGearNames } from './rankClaims';
import { getRankConfig } from './rankConfig';
import { fetchPlayerRankInputs } from './rankData';
import { scorePlayer } from './rankScoring';
import { setPlayerRank, getPlayerRank } from './playerStats';
import { rankIndex } from '$lib/ranks';

export interface RankCheckTarget {
	/** vs_users.id — used to fold in the member's approved manual gear claims. */
	userId: string;
	/** The player's RSN (their profile spelling; matched case-insensitively for caching). */
	rsn: string;
	/** Discord id for the players.rank write + previous-rank lookup (null falls back to RSN). */
	discordId: string | null;
	/** Account type so GIM members get iron-rate EHB (see rankScoring/ehb.ts). */
	accountType: string | null;
}

export interface RankCheckOutcome {
	/** The freshly computed composite rank (womRole). */
	rank: string;
	/** Whether the rank was persisted to players.rank (the bot mirrors it to Discord). */
	saved: boolean;
	/** True when a stats source was down, so the rank was deliberately NOT saved. */
	skippedSave: boolean;
	/** Rank held before this write (null when not looked up / no player record). */
	prevRank: string | null;
	/** A genuine, saved climb — drives the /me celebration. */
	rankedUp: boolean;
	templeAvailable: boolean;
	wikisyncAvailable: boolean;
	/** Why a save didn't happen when one was attempted (null on success or skip). */
	saveReason: 'no_player' | 'error' | null;
}

export type RankCheckResult =
	| { ok: true; outcome: RankCheckOutcome }
	| { ok: false; error: string };

// Fetch live inputs (WOM + Temple + WikiSync) for one player, score them with the current
// config, cache the breakdown in vs_rank_sim, and — only when both Temple and WikiSync
// responded — write players.rank. Never throws: transient failures come back as ok:false.
export async function checkAndSaveRank(target: RankCheckTarget): Promise<RankCheckResult> {
	const { userId, rsn, discordId, accountType } = target;
	try {
		// Approved manual gear claims merge into the gear calculation (items the Temple
		// clog can't prove — see rankClaims.ts).
		const manualGear = await getApprovedGearNames(userId);
		const [config, inputs] = await Promise.all([
			getRankConfig(),
			fetchPlayerRankInputs(rsn, undefined, manualGear, accountType)
		]);
		const { rank } = scorePlayer(inputs, config);

		// Cache the freshly-fetched inputs + piece-level detail in vs_rank_sim. The
		// upsert's onConflict key (rsn) is CASE-SENSITIVE, but the admin rank-sim keys rows
		// by the WOM canonical rsn while member checks use the profile rsn. Reuse the exact
		// key of any case/underscore-variant row that already exists, so we update that row
		// instead of minting a duplicate (loadRankBreakdown reads case-insensitively).
		const { data: existingRows } = await db()
			.from('vs_rank_sim')
			.select('rsn')
			.ilike('rsn', rsnExactPattern(rsn))
			.order('fetched_at', { ascending: false })
			.limit(1);
		const { error: cacheErr } = await db()
			.from('vs_rank_sim')
			.upsert(
				{
					rsn: existingRows?.[0]?.rsn ?? rsn,
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
			console.error(`[rank] vs_rank_sim upsert failed for "${rsn}": ${cacheErr.message}${cacheErr.code ? ` (${cacheErr.code})` : ''}`);
			return {
				ok: false,
				error: `Could not save the rank breakdown — ${cacheErr.message}${cacheErr.code ? ` (${cacheErr.code})` : ''}.`
			};
		}

		// If a stats source was down (Temple/WikiSync), its component degrades to 0 and the
		// composite is artificially low. Show the breakdown, but DON'T persist the rank —
		// players.rank mirrors to a Discord role, so saving a degraded score off a transient
		// 429/outage could wrongly demote the member.
		if (!inputs.templeAvailable || !inputs.wikisyncAvailable) {
			return {
				ok: true,
				outcome: {
					rank,
					saved: false,
					skippedSave: true,
					prevRank: null,
					rankedUp: false,
					templeAvailable: inputs.templeAvailable,
					wikisyncAvailable: inputs.wikisyncAvailable,
					saveReason: null
				}
			};
		}

		// Mirror the computed rank to the clan player record (the bot syncs it to Discord).
		// A missing player record isn't fatal — the breakdown still cached above.
		const prevRank = await getPlayerRank(discordId, rsn);
		const write = await setPlayerRank(discordId, rsn, rank);
		const rankedUp = write.ok && prevRank != null && rankIndex(rank) > rankIndex(prevRank);
		return {
			ok: true,
			outcome: {
				rank,
				saved: write.ok,
				skippedSave: false,
				prevRank,
				rankedUp,
				templeAvailable: true,
				wikisyncAvailable: true,
				saveReason: write.ok ? null : write.reason === 'no_player' ? 'no_player' : 'error'
			}
		};
	} catch (e) {
		const detail = e instanceof Error ? e.message : String(e);
		console.error(`[rank] check failed for "${rsn}":`, e);
		return { ok: false, error: `Rank check failed — ${detail}.` };
	}
}
