// SERVER-ONLY external-data layer for rank scoring. Mirrors the fetch logic in
// voli-disc-bot/scripts/simulateRanks.js (WOM clan + per-player WOM level, TempleOSRS
// collection log, RuneLite WikiSync combat achievements). All calls are best-effort:
// a failed source degrades that component to 0 rather than throwing, matching the
// bot's behaviour (and wom.ts's "return null on outage" style).

import { calculateGearPoints, calculateCAPoints, type RankInputs } from './rankScoring';

// Same WOM group as the bot (voli-disc-bot/config.json clanId).
const WOM_CLAN_ID = 4765;
const WOM_BASE = 'https://api.wiseoldman.net/v2';
const TEMPLE_BASE = 'https://templeosrs.com/api';
const WIKISYNC_BASE = 'https://sync.runescape.wiki/runelite/player';

const UA = { 'User-Agent': 'Volition-Site', Accept: 'application/json' };
const MONTH_MS = 1000 * 60 * 60 * 24 * 30.44;

async function getJson(url: string, timeoutMs = 15000): Promise<unknown | null> {
	const ctrl = new AbortController();
	const t = setTimeout(() => ctrl.abort(), timeoutMs);
	try {
		const res = await fetch(url, { headers: UA, signal: ctrl.signal });
		if (!res.ok) return null;
		return await res.json();
	} catch {
		return null;
	} finally {
		clearTimeout(t);
	}
}

export interface RosterEntry {
	rsn: string;
	womId: number | null;
	ehb: number;
	ehp: number;
	clanJoinedAt: string | null;
}

// One bulk WOM group call → lookup by lowercase RSN (ehb, ehp, join date, wom id).
export async function fetchClanRoster(): Promise<Record<string, RosterEntry>> {
	const data = (await getJson(`${WOM_BASE}/groups/${WOM_CLAN_ID}`)) as
		| { memberships?: Array<{ player: { id: number; displayName?: string; username?: string; ehb?: number; ehp?: number }; createdAt?: string }> }
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
			clanJoinedAt: m.createdAt ?? null
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

export async function fetchWikiSyncCA(rsn: string): Promise<number[] | null> {
	const data = (await getJson(`${WIKISYNC_BASE}/${encodeURIComponent(rsn)}/STANDARD`)) as
		| { combat_achievements?: number[] }
		| null;
	if (!data) return null;
	return data.combat_achievements || [];
}

// Piece-level detail surfaced for the on-profile rank breakdown (and cached in
// vs_rank_sim.gear_detail / .ca_detail so the /me Rank tab can render it on load).
export interface GearDetail {
	matchedItems: { name: string; earned: number; max: number }[];
	missedItems: string[];
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
export async function fetchPlayerRankInputs(
	rsn: string,
	roster?: Record<string, RosterEntry>
): Promise<PlayerRankData> {
	const r = roster ?? (await fetchClanRoster());
	const wom = r[rsn.toLowerCase()] ?? null;

	const [totalLevel, temple, ca] = await Promise.all([
		fetchPlayerTotalLevel(rsn),
		fetchTempleCollectionLog(rsn),
		fetchWikiSyncCA(rsn)
	]);

	const gear = calculateGearPoints(temple?.items);
	const caResult = calculateCAPoints(ca);

	return {
		rsn: wom?.rsn ?? rsn,
		womId: wom?.womId ?? null,
		ehb: wom?.ehb ?? 0,
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
		gearDetail: { matchedItems: gear.matchedItems, missedItems: gear.missedItems },
		caDetail: {
			tasksCompleted: caResult.tasksCompleted,
			wikiPoints: caResult.wikiPoints,
			highestTier: caResult.highestTier
		}
	};
}
