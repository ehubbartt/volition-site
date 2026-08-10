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
import { fetchPlayerRankInputs, type RosterEntry } from './rankData';
import { getTcgProgress } from './tcgProgress';
import { scorePlayer } from './rankScoring';
import { setPlayerRank, getPlayerRank, setPlayerSignatureRank } from './playerStats';
import { completedFromNormalized, earnedSignatureTier } from '$lib/rankSignature';
import { rankIndex } from '$lib/ranks';

export interface RankCheckTarget {
	/** vs_users.id — folds in the member's approved manual gear claims + TCG progress.
	 * null for a roster member with no site account (mass-update scores them by RSN):
	 * both reads then no-op, so they're scored on WOM/Temple/WikiSync alone. */
	userId: string | null;
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
	/** True when a stats source ERRORED transiently (not merely "no record"), so the rank was
	 * deliberately NOT saved to avoid a wrong demotion. A genuinely-untracked player saves. */
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
// config, cache the breakdown in vs_rank_sim, and write players.rank — UNLESS a stats source
// errored transiently (then the degraded score is not persisted). A player Temple/WikiSync
// has simply never tracked IS scored + saved on available data. Never throws: transient
// failures come back as ok:false.
// Pass a pre-fetched `roster` (the bulk WOM group call) when checking MANY players in a row
// — e.g. the mass rank update — so we don't re-fetch the whole clan once per player.
export async function checkAndSaveRank(
	target: RankCheckTarget,
	opts?: { roster?: Record<string, RosterEntry> }
): Promise<RankCheckResult> {
	const { userId, rsn, discordId, accountType } = target;
	try {
		// Approved manual gear claims merge into the gear calculation (items the Temple
		// clog can't prove — see rankClaims.ts).
		const manualGear = await getApprovedGearNames(userId);
		const [config, inputs, tcg] = await Promise.all([
			getRankConfig(),
			fetchPlayerRankInputs(rsn, opts?.roster, manualGear, accountType),
			getTcgProgress(userId)
		]);
		// Fold in the member's Volition TCG collection completion (RSN-keyed external
		// data can't read it — see rankData.ts) before scoring + caching.
		inputs.tcgOwned = tcg.owned;
		inputs.tcgTotal = tcg.total;
		const { rank, scores } = scorePlayer(inputs, config);
		// Signature (prestige) rank: how many whole categories are maxed → the tier earned.
		const signatureKey =
			earnedSignatureTier(completedFromNormalized(scores as unknown as Record<string, number>))?.key ?? null;

		// Bail on a transient source ERROR (429/timeout/5xx) BEFORE persisting anything — a
		// degraded pass zeros out gear/clog/CA, so writing it would both wrongly demote the
		// member (players.rank mirrors to a Discord role) AND poison the cached breakdown: the
		// vs_rank_sim row would read gear_points=0 / temple_available=false next to a retained
		// high rank, which the home page then shades as "ranked without Temple". Preserve the
		// member's last-good vs_rank_sim row and rank instead. A source that definitively has NO
		// record ('missing') is NOT an error: that 0 is real, so we fall through and persist the
		// correct rank on available data. During a true outage every source errors, so nothing
		// saves and no one is mass-demoted.
		if (inputs.templeStatus === 'error' || inputs.wikisyncStatus === 'error') {
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
					tcg_owned: inputs.tcgOwned,
					tcg_total: inputs.tcgTotal,
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

		// Mirror the computed rank to the clan player record (the bot syncs it to Discord).
		// A missing player record isn't fatal — the breakdown still cached above.
		const prevRank = await getPlayerRank(discordId, rsn);
		const write = await setPlayerRank(discordId, rsn, rank);
		// Refresh the earned signature tier on the player row (bot `/sync` reads it). A source
		// that's merely 'missing' can't inflate this — its whole categories stay incomplete, so
		// a member short on data simply won't earn a signature; only a transient 'error' (which
		// exits above) could understate it.
		await setPlayerSignatureRank(discordId, rsn, signatureKey);
		const rankedUp = write.ok && prevRank != null && rankIndex(rank) > rankIndex(prevRank);
		return {
			ok: true,
			outcome: {
				rank,
				saved: write.ok,
				skippedSave: false,
				prevRank,
				rankedUp,
				templeAvailable: inputs.templeAvailable,
				wikisyncAvailable: inputs.wikisyncAvailable,
				saveReason: write.ok ? null : write.reason === 'no_player' ? 'no_player' : 'error'
			}
		};
	} catch (e) {
		const detail = e instanceof Error ? e.message : String(e);
		console.error(`[rank] check failed for "${rsn}":`, e);
		return { ok: false, error: `Rank check failed — ${detail}.` };
	}
}
