// Pure, client-safe DuoWolf progression engine. Computes a team's stage state
// from plain counts + path choices — NO content (names/imgs) and NO db. This is
// the single source of truth shared by the board load and the board actions
// (submit/choosePath), so reveal and gating can never drift apart.

import {
	DUO_FLOORS,
	DUO_FLOOR_LANES,
	DUO_SECTIONS,
	DUO_SECTION_ROWS,
	duoStartId,
	duoMidId,
	duoPathId,
	duoBossId,
	duoNodeRefs,
	type DuoSection
} from './config';

export type StageKind = 'start' | 'section' | 'mid' | 'boss';

export interface Stage {
	index: number; // 0-based global order
	floor: number; // 1-based
	kind: StageKind;
	section?: DuoSection; // for 'section' (the choice) and 'mid' (the section it follows)
}

export type NodeState = 'locked' | 'choosable' | 'active' | 'complete' | 'dimmed';

export interface NodeProgress {
	approved: number;
	required: number;
	pending: number;
}

export interface ProgressInput {
	approvedByTile: Record<string, number>;
	pendingByTile: Record<string, number>;
	requiredByTile: Record<string, number>;
	choiceByFloorSection: Record<string, number>; // `${floor}:${section}` -> chosen lane
}

export interface ProgressResult {
	stages: Stage[];
	currentStageIndex: number; // === stages.length when the whole board is done
	nodeState: Record<string, NodeState>;
	nodeProgress: Record<string, NodeProgress>;
	chosenLaneByFloorSection: Record<string, number | null>;
	revealedNodeIds: Set<string>;
}

export function fsKey(floor: number, section: DuoSection): string {
	return `${floor}:${section}`;
}

// Ordered stages: per floor → start, A, mid-A, B, mid-B, C, boss.
export function buildStages(): Stage[] {
	const stages: Stage[] = [];
	let index = 0;
	for (let floor = 1; floor <= DUO_FLOORS; floor++) {
		stages.push({ index: index++, floor, kind: 'start' });
		for (let s = 0; s < DUO_SECTIONS.length; s++) {
			const section = DUO_SECTIONS[s];
			stages.push({ index: index++, floor, kind: 'section', section });
			if (s < DUO_SECTIONS.length - 1) {
				stages.push({ index: index++, floor, kind: 'mid', section });
			}
		}
		stages.push({ index: index++, floor, kind: 'boss' });
	}
	return stages;
}

// Optimistic completion: a tile counts as done from approved AND pending submissions, so
// a team progresses the instant they submit — without waiting for admin approval. A
// REJECTED submission stops counting (it's neither approved nor pending), so the tile
// drops back below `required` and the team has to redo it. Approved submissions are the
// locked-in part; pending is provisional.
function tileComplete(id: string, inp: ProgressInput): boolean {
	const have = (inp.approvedByTile[id] ?? 0) + (inp.pendingByTile[id] ?? 0);
	return have >= (inp.requiredByTile[id] ?? 1);
}

function stageSharedTileId(stage: Stage): string | null {
	if (stage.kind === 'start') return duoStartId(stage.floor);
	if (stage.kind === 'boss') return duoBossId(stage.floor);
	if (stage.kind === 'mid') return duoMidId(stage.floor, stage.section!);
	return null;
}

export function isStageComplete(stage: Stage, inp: ProgressInput): boolean {
	if (stage.kind === 'section') {
		const lane = inp.choiceByFloorSection[fsKey(stage.floor, stage.section!)];
		if (lane === undefined) return false; // a section needs an explicit path choice
		for (let step = 0; step < DUO_SECTION_ROWS; step++) {
			if (!tileComplete(duoPathId(stage.floor, stage.section!, lane, step), inp)) return false;
		}
		return true;
	}
	return tileComplete(stageSharedTileId(stage)!, inp);
}

export function computeProgress(inp: ProgressInput): ProgressResult {
	const stages = buildStages();
	let currentStageIndex = stages.findIndex((s) => !isStageComplete(s, inp));
	if (currentStageIndex === -1) currentStageIndex = stages.length;

	const stageIndexByKey = new Map<string, number>();
	for (const st of stages) {
		if (st.kind === 'start') stageIndexByKey.set(`start:${st.floor}`, st.index);
		else if (st.kind === 'boss') stageIndexByKey.set(`boss:${st.floor}`, st.index);
		else if (st.kind === 'mid') stageIndexByKey.set(`mid:${st.floor}:${st.section}`, st.index);
		else stageIndexByKey.set(`section:${st.floor}:${st.section}`, st.index);
	}

	const chosenLaneByFloorSection: Record<string, number | null> = {};
	for (let floor = 1; floor <= DUO_FLOORS; floor++) {
		for (const section of DUO_SECTIONS) {
			const k = fsKey(floor, section);
			chosenLaneByFloorSection[k] = inp.choiceByFloorSection[k] ?? null;
		}
	}

	const nodeState: Record<string, NodeState> = {};
	const nodeProgress: Record<string, NodeProgress> = {};
	const revealedNodeIds = new Set<string>();

	for (const ref of duoNodeRefs()) {
		let si: number;
		if (ref.kind === 'start') si = stageIndexByKey.get(`start:${ref.floor}`)!;
		else if (ref.kind === 'boss') si = stageIndexByKey.get(`boss:${ref.floor}`)!;
		else if (ref.kind === 'mid') si = stageIndexByKey.get(`mid:${ref.floor}:${ref.section}`)!;
		else si = stageIndexByKey.get(`section:${ref.floor}:${ref.section}`)!;

		let state: NodeState;
		if (ref.kind === 'path') {
			const lane = inp.choiceByFloorSection[fsKey(ref.floor, ref.section!)];
			if (si < currentStageIndex) {
				// Past section: only the chosen lane stays visible (completed).
				state = lane === ref.lane ? 'complete' : 'locked';
			} else if (si === currentStageIndex) {
				if (lane === undefined)
					state = 'choosable'; // all lanes shown so the team can compare + pick
				else if (lane === ref.lane) state = tileComplete(ref.id, inp) ? 'complete' : 'active';
				else state = 'dimmed'; // the paths they didn't pick (already seen) — greyed
			} else {
				state = 'locked';
			}
		} else {
			if (si < currentStageIndex) state = 'complete';
			else if (si === currentStageIndex) state = tileComplete(ref.id, inp) ? 'complete' : 'active';
			else state = 'locked';
		}

		nodeState[ref.id] = state;
		if (state !== 'locked') {
			revealedNodeIds.add(ref.id);
			nodeProgress[ref.id] = {
				approved: inp.approvedByTile[ref.id] ?? 0,
				pending: inp.pendingByTile[ref.id] ?? 0,
				required: inp.requiredByTile[ref.id] ?? 1
			};
		}
	}

	return {
		stages,
		currentStageIndex,
		nodeState,
		nodeProgress,
		chosenLaneByFloorSection,
		revealedNodeIds
	};
}

// Lane count for a floor (1-based), for choosePath range validation.
export function laneCountForFloor(floor: number): number {
	return DUO_FLOOR_LANES[floor - 1] ?? 0;
}
