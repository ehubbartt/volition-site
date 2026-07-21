// SERVER-ONLY external-data layer for rank scoring. Mirrors the fetch logic in
// voli-disc-bot/scripts/simulateRanks.js (WOM clan + per-player WOM level, TempleOSRS
// collection log, RuneLite WikiSync combat achievements). All calls are best-effort:
// a failed source degrades that component to 0 rather than throwing, matching the
// bot's behaviour (and wom.ts's "return null on outage" style).

import { calculateGearPoints, calculateCAPoints, type RankInputs, type GearPartial } from './rankScoring';
import { usesIronmanEhb, computeIronmanEhb } from './rankScoring/ehb';
import { getJson } from './http';
import { SKILLS, SKILL_WOM_KEY, type Skill } from '$lib/ehp';

// Same WOM group as the bot (voli-disc-bot/config.json clanId).
const WOM_CLAN_ID = 4765;
const WOM_BASE = 'https://api.wiseoldman.net/v2';
const TEMPLE_BASE = 'https://templeosrs.com/api';
const WIKISYNC_BASE = 'https://sync.runescape.wiki/runelite/player';

const MONTH_MS = 1000 * 60 * 60 * 24 * 30.44;

export interface RosterEntry {
	rsn: string;
	womId: number | null;
	ehb: number;
	ehp: number;
	clanJoinedAt: string | null;
	// The member's WOM group role — for a synced group this IS the in-game clan rank
	// (rank names like 'mithril'), but staff roles ('owner', 'deputy_owner', …) appear
	// too; map through toRankValue before treating it as a rank.
	womRole: string | null;
}

// One bulk WOM group call → lookup by lowercase RSN (ehb, ehp, join date, wom id, role).
export async function fetchClanRoster(): Promise<Record<string, RosterEntry>> {
	const data = (await getJson(`${WOM_BASE}/groups/${WOM_CLAN_ID}`)) as
		| { memberships?: Array<{ role?: string; player: { id: number; displayName?: string; username?: string; ehb?: number; ehp?: number }; createdAt?: string }> }
		| null;
	const memberships = data?.memberships ?? [];
	const lookup: Record<string, RosterEntry> = {};
	for (const m of memberships) {
		const rsn = m.player.displayName || m.player.username || '';
		if (!rsn) continue;
		lookup[rsn.toLowerCase()] = {
			rsn,
			womId: m.player.id ?? null,
			ehb: Math.round(m.player.ehb || 0),
			ehp: m.player.ehp || 0,
			clanJoinedAt: m.createdAt ?? null,
			womRole: m.role ?? null
		};
	}
	return lookup;
}

export async function fetchPlayerTotalLevel(rsn: string): Promise<number | null> {
	const data = (await getJson(`${WOM_BASE}/players/${encodeURIComponent(rsn)}`)) as
		| { latestSnapshot?: { data?: { skills?: { overall?: { level?: number } } } } }
		| null;
	return data?.latestSnapshot?.data?.skills?.overall?.level ?? null;
}

// Best-effort: ask WoM to refresh this player's snapshot so per-skill XP is current. WoM
// rate-limits updates (~1/min/player); failures are non-fatal — fetchPlayerSkillXp below
// falls back to the last stored snapshot.
export async function updateWomPlayer(rsn: string): Promise<void> {
	try {
		await fetch(`${WOM_BASE}/players/${encodeURIComponent(rsn)}`, { method: 'POST' });
	} catch {
		// ignore
	}
}

// Per-skill current XP from WoM's latest snapshot (used for skilling-tile baselines + the
// "gained since lock" check). Best-effort: null on outage; missing skills default to 0.
export async function fetchPlayerSkillXp(rsn: string): Promise<Record<Skill, number> | null> {
	const data = (await getJson(`${WOM_BASE}/players/${encodeURIComponent(rsn)}`)) as
		| { latestSnapshot?: { data?: { skills?: Record<string, { experience?: number }> } } }
		| null;
	const skills = data?.latestSnapshot?.data?.skills;
	if (!skills) return null;
	const out = {} as Record<Skill, number>;
	for (const s of SKILLS) {
		const xp = skills[SKILL_WOM_KEY[s]]?.experience;
		out[s] = typeof xp === 'number' && xp >= 0 ? xp : 0;
	}
	return out;
}

// Per-boss KC from WOM's latest snapshot, for recomputing a GIM's EHB on iron rates
// (rankScoring/ehb.ts). Keyed by WOM boss metric (e.g. 'zulrah'); WOM reports -1 for
// unranked bosses, which we drop so only real kill counts feed the calc. Best-effort:
// null on outage → the caller keeps WOM's own EHB.
export async function fetchPlayerBossKills(rsn: string): Promise<Record<string, number> | null> {
	const data = (await getJson(`${WOM_BASE}/players/${encodeURIComponent(rsn)}`)) as
		| { latestSnapshot?: { data?: { bosses?: Record<string, { kills?: number }> } } }
		| null;
	const bosses = data?.latestSnapshot?.data?.bosses;
	if (!bosses) return null;
	const out: Record<string, number> = {};
	for (const [metric, v] of Object.entries(bosses)) {
		const kills = v?.kills;
		if (typeof kills === 'number' && kills > 0) out[metric] = kills;
	}
	return out;
}

export async function fetchTempleCollectionLog(
	rsn: string
): Promise<{ items: Record<string, unknown>; finished: number; available: number } | null> {
	const url = `${TEMPLE_BASE}/collection-log/player_collection_log.php?player=${encodeURIComponent(
		rsn
	)}&categories=all&includenames=1`;
	const data = (await getJson(url, 20000)) as
		| { data?: { items?: Record<string, unknown>; total_collections_finished?: number; total_collections_available?: number } }
		| null;
	const d = data?.data;
	if (!d) return null;
	return {
		items: d.items || {},
		finished: d.total_collections_finished || 0,
		available: d.total_collections_available || 0
	};
}

// One WikiSync request serving both CA and achievement-diary state. `diaries` maps
// region → tier → done and is null when the response lacked the diaries block — the
// caller must treat that as UNAVAILABLE, never as "nothing completed" (a board would
// otherwise deal players diaries they've already finished).
export interface WikiSyncPlayer {
	caIds: number[];
	diaries: Record<string, Record<string, boolean>> | null;
}

export async function fetchWikiSyncPlayer(rsn: string): Promise<WikiSyncPlayer | null> {
	const data = (await getJson(`${WIKISYNC_BASE}/${encodeURIComponent(rsn)}/STANDARD`)) as
		| { combat_achievements?: number[]; achievement_diaries?: Record<string, unknown> }
		| null;
	if (!data) return null;

	// Parse the diaries block defensively: WikiSync reports region → tier →
	// { complete, tasks } (accept a bare boolean too, in case the shape ever slims).
	let diaries: WikiSyncPlayer['diaries'] = null;
	const raw = data.achievement_diaries;
	if (raw && typeof raw === 'object') {
		diaries = {};
		for (const [region, tiers] of Object.entries(raw)) {
			if (!tiers || typeof tiers !== 'object') continue;
			const out: Record<string, boolean> = {};
			for (const [tier, v] of Object.entries(tiers as Record<string, unknown>)) {
				out[tier] =
					v === true || (typeof v === 'object' && v !== null && (v as { complete?: unknown }).complete === true);
			}
			diaries[region] = out;
		}
	}

	return { caIds: data.combat_achievements || [], diaries };
}

export async function fetchWikiSyncCA(rsn: string): Promise<number[] | null> {
	const player = await fetchWikiSyncPlayer(rsn);
	return player ? player.caIds : null;
}

// Piece-level detail surfaced for the on-profile rank breakdown (and cached in
// vs_rank_sim.gear_detail / .ca_detail so the /me Rank tab can render it on load).
export interface GearDetail {
	matchedItems: { name: string; earned: number; max: number }[];
	missedItems: string[];
	// Partially-obtained entries (some but not all checks met) — 0 points, shown as
	// in-progress in the gear grid with what's still missing. Optional for back-compat
	// with rows cached before this field existed.
	partials?: GearPartial[];
}
export interface CADetail {
	tasksCompleted: number;
	wikiPoints: number;
	highestTier: string;
}

export interface PlayerRankData extends RankInputs {
	rsn: string;
	womId: number | null;
	clanJoinedAt: string | null;
	templeAvailable: boolean;
	wikisyncAvailable: boolean;
	caTier: string;
	gearDetail: GearDetail;
	caDetail: CADetail;
}

export function monthsBetween(joinedAt: string | null): number {
	if (!joinedAt) return 0;
	const ms = Date.now() - new Date(joinedAt).getTime();
	return ms > 0 ? ms / MONTH_MS : 0;
}

// Fetch every input needed to score ONE player. `roster` (the bulk WOM call) supplies
// ehb + join date; pass it in when scoring many players so we don't re-fetch the group
// per player. Missing roster entry → ehb/time default to 0 (non-clan or unsynced).
// `manualGearNames` = the player's admin-approved gear claims (rankClaims.ts) — items
// the Temple clog can't prove, merged into the gear calculation as owned.
// `accountType` = the member's site account_type; group-ironman accounts have their EHB
// recomputed on iron rates (rankScoring/ehb.ts) instead of using WOM's value for them.
export async function fetchPlayerRankInputs(
	rsn: string,
	roster?: Record<string, RosterEntry>,
	manualGearNames?: string[],
	accountType?: string | null
): Promise<PlayerRankData> {
	const r = roster ?? (await fetchClanRoster());
	const wom = r[rsn.toLowerCase()] ?? null;

	// GIM accounts: re-derive EHB from boss KCs on iron rates (fetched in parallel).
	const iron = usesIronmanEhb(accountType);
	const [totalLevel, temple, ca, bossKills] = await Promise.all([
		fetchPlayerTotalLevel(rsn),
		fetchTempleCollectionLog(rsn),
		fetchWikiSyncCA(rsn),
		iron ? fetchPlayerBossKills(rsn) : Promise.resolve(null)
	]);

	const gear = calculateGearPoints(temple?.items, manualGearNames);
	const caResult = calculateCAPoints(ca);
	// Iron EHB only overrides when the boss snapshot actually came back; on a WOM outage
	// we keep WOM's EHB rather than zeroing a GIM's whole EHB component.
	const ehb = iron && bossKills ? Math.round(computeIronmanEhb(bossKills)) : wom?.ehb ?? 0;

	return {
		rsn: wom?.rsn ?? rsn,
		womId: wom?.womId ?? null,
		ehb,
		clanJoinedAt: wom?.clanJoinedAt ?? null,
		monthsInClan: monthsBetween(wom?.clanJoinedAt ?? null),
		totalLevel,
		gearPoints: gear.gearPoints,
		clogFinished: temple?.finished ?? 0,
		clogAvailable: temple?.available ?? 0,
		caPoints: caResult.caPoints,
		templeAvailable: temple != null,
		wikisyncAvailable: ca != null,
		caTier: caResult.highestTier,
		gearDetail: { matchedItems: gear.matchedItems, missedItems: gear.missedItems, partials: gear.partials },
		caDetail: {
			tasksCompleted: caResult.tasksCompleted,
			wikiPoints: caResult.wikiPoints,
			highestTier: caResult.highestTier
		}
	};
}
