// SERVER-ONLY external-data layer for rank scoring. Mirrors the fetch logic in
// voli-disc-bot/scripts/simulateRanks.js (WOM clan + per-player WOM level, TempleOSRS
// collection log, RuneLite WikiSync combat achievements). All calls are best-effort:
// a failed source degrades that component to 0 rather than throwing, matching the
// bot's behaviour (and wom.ts's "return null on outage" style).

import {
	calculateGearPoints,
	calculateCAPoints,
	type RankInputs,
	type GearPartial,
	type ManualGearItem
} from './rankScoring';
import { usesIronmanEhb, computeIronmanEhb } from './rankScoring/ehb';
import { getJsonOutcome } from './http';
import { womGet, womPost } from './womClient';
import { SKILLS, SKILL_WOM_KEY, type Skill } from '$lib/ehp';

// Same WOM group as the bot (voli-disc-bot/config.json clanId).
const WOM_CLAN_ID = 4765;
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

type WomGroup = {
	memberships?: Array<{ role?: string; player: { id: number; displayName?: string; username?: string; ehb?: number; ehp?: number }; createdAt?: string }>;
};

// One bulk WOM group call → lookup by lowercase RSN (ehb, ehp, join date, wom id, role).
// 'error' when WOM didn't answer (rate limit / outage) or answered with no members — a clan
// of zero is never real, and scoring against it zeroes everyone's EHB and time in clan.
export async function fetchClanRosterResult(): Promise<SourceResult<Record<string, RosterEntry>>> {
	const res = await womGet<WomGroup>(`/groups/${WOM_CLAN_ID}`);
	if (res.status !== 'ok') return { status: 'error' };
	const memberships = res.data?.memberships ?? [];
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
	if (Object.keys(lookup).length === 0) return { status: 'error' };
	return { status: 'ok', data: lookup };
}

// Back-compat: the roster, or {} when WOM is unavailable. Callers that SAVE anything from it
// must use fetchClanRosterResult and stop on 'error' instead.
export async function fetchClanRoster(): Promise<Record<string, RosterEntry>> {
	const res = await fetchClanRosterResult();
	return res.status === 'ok' ? res.data : {};
}

type WomPlayer = {
	ehb?: number;
	latestSnapshot?: { data?: { skills?: Record<string, { level?: number; experience?: number }>; bosses?: Record<string, { kills?: number }> } };
};

// The rank inputs WOM's player profile carries: total level (null when WOM has no snapshot)
// and the player's own EHB. 'missing' = WOM has never tracked this name (404); 'error' = WOM
// didn't answer (rate limit / outage) — the caller must not save a score built on it.
// EHB is read here as well as from the group roster because members who aren't in the clan's
// WOM group (not added yet, or a name change WOM hasn't linked) are absent from the roster,
// which used to score their EHB as 0 even though WOM tracks it on their profile.
export async function fetchPlayerWomResult(rsn: string): Promise<SourceResult<{ level: number | null; ehb: number }>> {
	const res = await womGet<WomPlayer>(`/players/${encodeURIComponent(rsn)}`);
	if (res.status !== 'ok') return res;
	const level = res.data?.latestSnapshot?.data?.skills?.overall?.level;
	return {
		status: 'ok',
		data: { level: typeof level === 'number' && level > 0 ? level : null, ehb: Math.round(res.data?.ehb || 0) }
	};
}

// Total level from WOM's latest snapshot. 'missing' = WOM has never tracked this name (404)
// or has no snapshot for it — a real "unknown", so the level component scores 0. 'error' =
// WOM didn't answer (rate limit / outage) — the caller must not save a score built on it.
export async function fetchPlayerTotalLevelResult(rsn: string): Promise<SourceResult<number>> {
	const res = await womGet<WomPlayer>(`/players/${encodeURIComponent(rsn)}`);
	if (res.status !== 'ok') return res;
	const level = res.data?.latestSnapshot?.data?.skills?.overall?.level;
	return typeof level === 'number' && level > 0 ? { status: 'ok', data: level } : { status: 'missing' };
}

export async function fetchPlayerTotalLevel(rsn: string): Promise<number | null> {
	const res = await fetchPlayerTotalLevelResult(rsn);
	return res.status === 'ok' ? res.data : null;
}

// Best-effort: ask WoM to refresh this player's snapshot so per-skill XP is current. WoM
// rate-limits updates (~1/min/player); failures are non-fatal — fetchPlayerSkillXp below
// falls back to the last stored snapshot.
export async function updateWomPlayer(rsn: string): Promise<void> {
	await womPost(`/players/${encodeURIComponent(rsn)}`);
}

// Per-skill current XP from WoM's latest snapshot (used for skilling-tile baselines + the
// "gained since lock" check). Best-effort: null on outage; missing skills default to 0.
export async function fetchPlayerSkillXp(rsn: string): Promise<Record<Skill, number> | null> {
	const res = await womGet<WomPlayer>(`/players/${encodeURIComponent(rsn)}`);
	const skills = res.status === 'ok' ? res.data?.latestSnapshot?.data?.skills : undefined;
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
	const res = await womGet<WomPlayer>(`/players/${encodeURIComponent(rsn)}`);
	const bosses = res.status === 'ok' ? res.data?.latestSnapshot?.data?.bosses : undefined;
	if (!bosses) return null;
	const out: Record<string, number> = {};
	for (const [metric, v] of Object.entries(bosses)) {
		const kills = v?.kills;
		if (typeof kills === 'number' && kills > 0) out[metric] = kills;
	}
	return out;
}

// Whether an external source (Temple / WikiSync) answered for a player, could NOT answer,
// or errored transiently. 'missing' vs 'error' is the distinction the rank save-gate needs:
// a genuinely-untracked player ('missing') is still scored + saved on available data, while
// a transient outage ('error') skips the save so nobody is wrongly demoted (see rankCheck).
export type SourceStatus = 'ok' | 'missing' | 'error';

export interface TempleClog {
	items: Record<string, unknown>;
	finished: number;
	available: number;
	/** The player's exact in-game spelling as Temple reports it (e.g. "Chest X-Ray"). WOM
	 * folds hyphens into spaces ("Chest X Ray"), but WikiSync keys players by the exact name,
	 * so this is the spelling to retry WikiSync with. Null when Temple didn't say. */
	displayName: string | null;
}

export type SourceResult<T> = { status: 'ok'; data: T } | { status: 'missing' } | { status: 'error' };

// Status-aware Temple fetch. 'ok' + the clog, 'missing' when Temple has no record for the RSN
// (a 404, or a 200 whose body has no `data` block — how Temple answers for an untracked
// player), or 'error' on a transient outage.
export async function fetchTempleCollectionLogResult(rsn: string): Promise<SourceResult<TempleClog>> {
	const url = `${TEMPLE_BASE}/collection-log/player_collection_log.php?player=${encodeURIComponent(
		rsn
	)}&categories=all&includenames=1`;
	const res = await getJsonOutcome<{
		data?: {
			items?: Record<string, unknown>;
			total_collections_finished?: number;
			total_collections_available?: number;
			player_name_with_capitalization?: string;
		};
	}>(url, 20000);
	if (res.status === 'error') return { status: 'error' };
	if (res.status === 'missing') return { status: 'missing' };
	const d = res.data?.data;
	// Temple answered, but has no collection log for this RSN → definitively untracked.
	if (!d) return { status: 'missing' };
	return {
		status: 'ok',
		data: {
			items: d.items || {},
			finished: d.total_collections_finished || 0,
			available: d.total_collections_available || 0,
			displayName: d.player_name_with_capitalization?.trim() || null
		}
	};
}

// Back-compat wrapper: the clog, or null on missing/error. Board/task callers that only care
// "did we get data" keep using this; the rank path uses the status-aware variant above.
export async function fetchTempleCollectionLog(rsn: string): Promise<TempleClog | null> {
	const res = await fetchTempleCollectionLogResult(rsn);
	return res.status === 'ok' ? res.data : null;
}

// One WikiSync request serving both CA and achievement-diary state. `diaries` maps
// region → tier → done and is null when the response lacked the diaries block — the
// caller must treat that as UNAVAILABLE, never as "nothing completed" (a board would
// otherwise deal players diaries they've already finished).
export interface WikiSyncPlayer {
	caIds: number[];
	diaries: Record<string, Record<string, boolean>> | null;
}

// Status-aware WikiSync fetch. WikiSync answers a player who has never run the RuneLite
// plugin with 400 {"code":"NO_USER_DATA"} (a 404 is treated the same) → 'missing'; other
// non-OK / network / timeout is 'error' (transient). Treating that 400 as an outage used to
// make every never-synced member's rank check skip its save.
export async function fetchWikiSyncPlayerResult(rsn: string): Promise<SourceResult<WikiSyncPlayer>> {
	const res = await getJsonOutcome<{ combat_achievements?: number[]; achievement_diaries?: Record<string, unknown> }>(
		`${WIKISYNC_BASE}/${encodeURIComponent(rsn)}/STANDARD`,
		undefined,
		(status, body) => status === 400 && (body as { code?: unknown } | null)?.code === 'NO_USER_DATA'
	);
	if (res.status === 'error') return { status: 'error' };
	if (res.status === 'missing') return { status: 'missing' };
	const data = res.data;
	if (!data) return { status: 'missing' };

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

	return { status: 'ok', data: { caIds: data.combat_achievements || [], diaries } };
}

// WikiSync keys players by their EXACT name, hyphens included, but the clan roster (WOM) and
// site profiles often carry a hyphen-less spelling ("Chest X Ray" for "Chest X-Ray"). When
// WikiSync has nothing under the roster spelling, retry once under Temple's reported
// spelling. Temple matches names loosely, so it finds the player either way.
export async function retryWikiSyncAs(
	rsn: string,
	first: SourceResult<WikiSyncPlayer>,
	templeName: string | null | undefined
): Promise<SourceResult<WikiSyncPlayer>> {
	if (first.status !== 'missing' || !templeName) return first;
	if (templeName.toLowerCase() === rsn.trim().toLowerCase()) return first;
	return fetchWikiSyncPlayerResult(templeName);
}

export async function fetchWikiSyncPlayer(rsn: string): Promise<WikiSyncPlayer | null> {
	const res = await fetchWikiSyncPlayerResult(rsn);
	return res.status === 'ok' ? res.data : null;
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
	// `*Available` = the source returned real DATA (status 'ok') — drives the breakdown display
	// and the home non-Temple shading. `*Status` additionally distinguishes 'missing' (the
	// player is genuinely untracked → their 0 is real) from 'error' (transient outage → don't
	// trust the 0), which is what the save-gate in rankCheck keys off.
	templeAvailable: boolean;
	wikisyncAvailable: boolean;
	templeStatus: SourceStatus;
	wikisyncStatus: SourceStatus;
	/** 'error' when WOM didn't answer for the roster or the total level (rate limit / outage):
	 * EHB, time in clan and total level would score as 0, so the save-gate must hold. */
	womStatus: SourceStatus;
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
// `manualGear` = the player's approved gear claims and admin grants (rankClaims.ts) —
// items the Temple clog can't prove, merged into the gear calculation as owned, each with
// the count it's credited at (four Zenyte shards from before the log existed).
// `accountType` = the member's site account_type; group-ironman accounts have their EHB
// recomputed on iron rates (rankScoring/ehb.ts) instead of using WOM's value for them.
export async function fetchPlayerRankInputs(
	rsn: string,
	roster?: Record<string, RosterEntry>,
	manualGear?: ManualGearItem[],
	accountType?: string | null
): Promise<PlayerRankData> {
	// A caller-supplied roster was already checked; otherwise a failed roster is an error.
	const rosterRes: SourceResult<Record<string, RosterEntry>> = roster
		? { status: 'ok', data: roster }
		: await fetchClanRosterResult();
	const r = rosterRes.status === 'ok' ? rosterRes.data : {};
	const wom = r[rsn.toLowerCase()] ?? null;

	// GIM accounts: re-derive EHB from boss KCs on iron rates (fetched in parallel).
	const iron = usesIronmanEhb(accountType);
	const [playerRes, templeRes, wikiFirst, bossKills] = await Promise.all([
		fetchPlayerWomResult(rsn),
		fetchTempleCollectionLogResult(rsn),
		fetchWikiSyncPlayerResult(rsn),
		iron ? fetchPlayerBossKills(rsn) : Promise.resolve(null)
	]);

	const womPlayer = playerRes.status === 'ok' ? playerRes.data : null;
	const totalLevel = womPlayer?.level ?? null;
	const womStatus: SourceStatus =
		rosterRes.status === 'error' || playerRes.status === 'error' ? 'error' : 'ok';
	const temple = templeRes.status === 'ok' ? templeRes.data : null;
	const wikiRes = await retryWikiSyncAs(rsn, wikiFirst, temple?.displayName);
	const ca = wikiRes.status === 'ok' ? wikiRes.data.caIds : null;
	const gear = calculateGearPoints(temple?.items, manualGear);
	const caResult = calculateCAPoints(ca);
	// Iron EHB only overrides when the boss snapshot actually came back; on a WOM outage
	// we keep WOM's EHB rather than zeroing a GIM's whole EHB component.
	// Not in the clan's WOM group → no roster entry; fall back to the EHB on their own profile.
	const ehb = iron && bossKills ? Math.round(computeIronmanEhb(bossKills)) : wom?.ehb ?? womPlayer?.ehb ?? 0;

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
		// TCG completion isn't readable from RSN-keyed external data — the caller that
		// has the member's site user id (rankCheck) fills these in before scoring.
		tcgOwned: 0,
		tcgTotal: 0,
		templeAvailable: templeRes.status === 'ok',
		wikisyncAvailable: wikiRes.status === 'ok',
		templeStatus: templeRes.status,
		wikisyncStatus: wikiRes.status,
		womStatus,
		caTier: caResult.highestTier,
		gearDetail: { matchedItems: gear.matchedItems, missedItems: gear.missedItems, partials: gear.partials },
		caDetail: {
			tasksCompleted: caResult.tasksCompleted,
			wikiPoints: caResult.wikiPoints,
			highestTier: caResult.highestTier
		}
	};
}
