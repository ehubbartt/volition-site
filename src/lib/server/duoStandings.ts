// SERVER-ONLY DuoWolf standings: rank every team by how far they've climbed, exposing
// ONLY the stage (floor/section) — never tile names/content, so it can't spoil the board.
// Shared by the board page (leaderboard side panel + on-board markers) AND the duo event
// page (the "board is live" panel that replaces signups once they close).

import { db, fetchAllFiltered } from './db';
import {
	duoNodeRefs,
	DUO_FLOORS,
	DUO_SECTION_ROWS,
	duoStartId,
	duoMidId,
	duoBossId,
	duoPathId
} from '$lib/board/config';
import { computeProgress, laneCountForFloor, type ProgressResult, type Stage } from '$lib/board/progress';
import { DUO_TILE_IDS, getDuoTileRequired } from './duoWolfTiles';
import { ensureDuoTilesFresh } from './duoTileStore';
import { CLAN_OPTIONS, CLAN_LABEL } from '$lib/clans';

export interface LeaderEntry {
	rank: number; // global rank across all teams
	name: string;
	stageLabel: string;
	floor: number;
	stageIndex: number;
	pct: number; // stageIndex / total stages
	finished: boolean;
	tilesComplete: number;
	isMine: boolean;
	clan: string; // team's clan key (single clan, or 'mixed' / 'unknown')
	clanLabel: string;
	members: string[]; // the team members' RSNs (falls back to Discord name)
	// Tiles done in the CURRENT section (only when the current stage is a section, i.e.
	// sectionTotal > 0) — lets the leaderboard show "Section A (2/3)" instead of just the section.
	sectionDone: number;
	sectionTotal: number;
}

export interface ClanGroup {
	clan: string;
	label: string;
	entries: LeaderEntry[]; // this clan's teams, best first (keeps global rank numbers)
}

export interface DuoStandings {
	leaderboard: LeaderEntry[]; // top N overall ("All" tab)
	byClan: ClanGroup[]; // per-clan top teams (clan tabs)
	teamMarkers: Record<string, { rank: number; name: string }[]>; // top M → nodeId → names
	teamCount: number;
	myEntry: LeaderEntry | null; // the requesting team's row (any rank)
}

const CLAN_KEY_ORDER = [...CLAN_OPTIONS.map((c) => c.value), 'mixed', 'unknown'];

function clanLabelFor(clan: string): string {
	if (clan in CLAN_LABEL) return CLAN_LABEL[clan as keyof typeof CLAN_LABEL];
	if (clan === 'mixed') return 'Mixed clans';
	return 'Unknown';
}

// Spoiler-free stage label (floor + section, NEVER the tile name).
export function duoStageLabel(stage: Stage | undefined): string {
	if (!stage) return 'Finished';
	if (stage.kind === 'start') return `Floor ${stage.floor} · Start`;
	if (stage.kind === 'boss') return `Floor ${stage.floor} · Boss`;
	if (stage.kind === 'mid') return `Floor ${stage.floor} · Intermission ${stage.section}`;
	return `Floor ${stage.floor} · Section ${stage.section}`;
}

// A single representative board node for "where a team is" (for the on-board name tags).
function teamMarkerNode(prog: ProgressResult): string | null {
	const stage = prog.stages[prog.currentStageIndex];
	if (!stage) return null; // finished
	if (stage.kind === 'start') return duoStartId(stage.floor);
	if (stage.kind === 'boss') return duoBossId(stage.floor);
	if (stage.kind === 'mid') return duoMidId(stage.floor, stage.section!);
	let best: string | null = null;
	let bestStep = Infinity;
	for (const ref of duoNodeRefs()) {
		if (
			ref.kind === 'path' &&
			ref.floor === stage.floor &&
			ref.section === stage.section &&
			prog.nodeState[ref.id] === 'active' &&
			(ref.step ?? 0) < bestStep
		) {
			bestStep = ref.step ?? 0;
			best = ref.id;
		}
	}
	if (best) return best;
	const lanes = laneCountForFloor(stage.floor);
	return duoPathId(stage.floor, stage.section!, Math.floor(lanes / 2), 0);
}

export async function loadDuoStandings(
	eventId: string,
	myTeamId: string | null,
	opts: { topN?: number; markersTopN?: number; perClanCap?: number } = {}
): Promise<DuoStandings> {
	const topN = opts.topN ?? 20;
	const markersTopN = opts.markersTopN ?? 10;
	const perClanCap = opts.perClanCap ?? 20;

	// Required counts feed the progress engine — keep the admin-edited tile content fresh.
	await ensureDuoTilesFresh();

	const sb = db();
	// Paginate every event-wide read past the 1000-row cap — `subs` especially, which silently
	// truncated (and broke all progress) once the event crossed 1000 submissions.
	const [{ data: teamRows }, { data: allChoices }, { data: allSwaps }, { data: subs }, { data: signups }] =
		await Promise.all([
			fetchAllFiltered((f, t) => sb.from('vs_teams').select('id, name').eq('event_id', eventId).range(f, t)),
			fetchAllFiltered((f, t) =>
				sb.from('vs_team_path_choices').select('team_id, floor, section, lane').eq('event_id', eventId).range(f, t)
			),
			fetchAllFiltered((f, t) =>
				sb.from('vs_team_tile_swaps').select('team_id, floor, section, step, lane').eq('event_id', eventId).range(f, t)
			),
			fetchAllFiltered((f, t) =>
				sb.from('vs_submissions').select('team_id, target_id, status, quantity').eq('event_id', eventId).range(f, t)
			),
			fetchAllFiltered((f, t) =>
				sb
					.from('vs_event_signups')
					.select('team_id, vs_users(rsn, discord_username, clan_allegiance)')
					.eq('event_id', eventId)
					.range(f, t)
			)
		]);

	// A team's clan = its members' clan if they share one, else "mixed" (matches the
	// signup-page grouping). Used for the leaderboard's per-clan tabs.
	const teamClanSets: Record<string, Set<string>> = {};
	const teamMembers: Record<string, string[]> = {};
	for (const s of (signups ?? []) as unknown as {
		team_id: string | null;
		vs_users: { rsn: string | null; discord_username: string | null; clan_allegiance: string | null } | null;
	}[]) {
		if (!s.team_id) continue;
		(teamClanSets[s.team_id] ??= new Set()).add(s.vs_users?.clan_allegiance ?? 'unknown');
		const name = s.vs_users?.rsn ?? s.vs_users?.discord_username;
		if (name) (teamMembers[s.team_id] ??= []).push(name);
	}
	const teamClan: Record<string, string> = {};
	for (const [tid, set] of Object.entries(teamClanSets)) {
		teamClan[tid] = set.size === 1 ? [...set][0] : 'mixed';
	}

	const requiredByTile: Record<string, number> = {};
	for (const ref of duoNodeRefs()) requiredByTile[ref.id] = getDuoTileRequired(ref.id);

	const teamApproved: Record<string, Record<string, number>> = {};
	const teamPending: Record<string, Record<string, number>> = {};
	for (const c of (subs ?? []) as {
		team_id: string | null;
		target_id: string;
		status: string;
		quantity: number | null;
	}[]) {
		if (!c.team_id || !DUO_TILE_IDS.has(c.target_id)) continue;
		if (c.status !== 'approved' && c.status !== 'pending') continue;
		const q = Math.max(1, Number(c.quantity) || 1);
		const bucket = c.status === 'approved' ? teamApproved : teamPending;
		const m = (bucket[c.team_id] ??= {});
		m[c.target_id] = (m[c.target_id] ?? 0) + q;
	}
	const teamChoice: Record<string, Record<string, number>> = {};
	for (const ch of (allChoices ?? []) as {
		team_id: string;
		floor: number;
		section: string;
		lane: number;
	}[]) {
		(teamChoice[ch.team_id] ??= {})[`${ch.floor}:${ch.section}`] = ch.lane;
	}
	const teamSwap: Record<string, Record<string, number>> = {};
	for (const s of (allSwaps ?? []) as {
		team_id: string;
		floor: number;
		section: string;
		step: number;
		lane: number;
	}[]) {
		(teamSwap[s.team_id] ??= {})[`${s.floor}:${s.section}:${s.step}`] = s.lane;
	}

	const ranked = ((teamRows ?? []) as { id: string; name: string | null }[])
		.map((t) => {
			const prog = computeProgress({
				approvedByTile: teamApproved[t.id] ?? {},
				pendingByTile: teamPending[t.id] ?? {},
				requiredByTile,
				choiceByFloorSection: teamChoice[t.id] ?? {},
				swapByPositionKey: teamSwap[t.id] ?? {}
			});
			const stagesTotal = prog.stages.length;
			const stage = prog.stages[prog.currentStageIndex];
			const tilesComplete = Object.values(prog.nodeState).filter((s) => s === 'complete').length;
			const clan = teamClan[t.id] ?? 'unknown';
			// Tiles complete within the current section (a section has DUO_SECTION_ROWS tiles;
			// only the played lane's tiles ever reach 'complete', so this counts 0..3).
			let sectionDone = 0;
			let sectionTotal = 0;
			if (stage && stage.kind === 'section') {
				sectionTotal = DUO_SECTION_ROWS;
				for (const ref of duoNodeRefs()) {
					if (
						ref.kind === 'path' &&
						ref.floor === stage.floor &&
						ref.section === stage.section &&
						prog.nodeState[ref.id] === 'complete'
					)
						sectionDone++;
				}
			}
			return {
				teamId: t.id,
				name: t.name ?? 'Unnamed team',
				stageIndex: prog.currentStageIndex,
				pct: Math.round((Math.min(prog.currentStageIndex, stagesTotal) / stagesTotal) * 100),
				finished: prog.currentStageIndex >= stagesTotal,
				floor: stage?.floor ?? DUO_FLOORS,
				stageLabel: duoStageLabel(stage),
				tilesComplete,
				markerNode: teamMarkerNode(prog),
				isMine: t.id === myTeamId,
				clan,
				clanLabel: clanLabelFor(clan),
				members: teamMembers[t.id] ?? [],
				sectionDone,
				sectionTotal
			};
		})
		.sort(
			(a, b) =>
				b.stageIndex - a.stageIndex ||
				b.tilesComplete - a.tilesComplete ||
				a.name.localeCompare(b.name)
		)
		.map((t, i) => ({ ...t, rank: i + 1 }));

	const toEntry = (t: (typeof ranked)[number]): LeaderEntry => ({
		rank: t.rank,
		name: t.name,
		stageLabel: t.stageLabel,
		floor: t.floor,
		stageIndex: t.stageIndex,
		pct: t.pct,
		finished: t.finished,
		tilesComplete: t.tilesComplete,
		isMine: t.isMine,
		clan: t.clan,
		clanLabel: t.clanLabel,
		members: t.members,
		sectionDone: t.sectionDone,
		sectionTotal: t.sectionTotal
	});

	const teamMarkers: Record<string, { rank: number; name: string }[]> = {};
	for (const t of ranked.slice(0, markersTopN)) {
		if (!t.markerNode || t.finished) continue;
		(teamMarkers[t.markerNode] ??= []).push({ rank: t.rank, name: t.name });
	}

	// Per-clan tabs: each clan's top teams (ranked is globally sorted, so best-first holds).
	const byClanMap = new Map<string, LeaderEntry[]>();
	for (const t of ranked) {
		const arr = byClanMap.get(t.clan) ?? [];
		if (arr.length < perClanCap) arr.push(toEntry(t));
		byClanMap.set(t.clan, arr);
	}
	const byClan: ClanGroup[] = CLAN_KEY_ORDER.filter((k) => byClanMap.has(k)).map((k) => ({
		clan: k,
		label: clanLabelFor(k),
		entries: byClanMap.get(k)!
	}));

	const mine = ranked.find((t) => t.isMine);
	return {
		leaderboard: ranked.slice(0, topN).map(toEntry),
		byClan,
		teamMarkers,
		teamCount: ranked.length,
		myEntry: mine ? toEntry(mine) : null
	};
}
