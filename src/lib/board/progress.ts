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
	rejected: number; // team's rejected submissions on this tile (drives the "redo" warning)
}

export interface ProgressInput {
	approvedByTile: Record<string, number>;
	pendingByTile: Record<string, number>;
	requiredByTile: Record<string, number>;
	choiceByFloorSection: Record<string, number>; // `${floor}:${section}` -> chosen lane
	// SWAPS: `${floor}:${section}:${step}` -> the adjacent lane swapped IN at that position.
	// When set, the team plays that lane's tile for the step instead of their chosen lane's.
	swapByPositionKey?: Record<string, number>;
	// Count of the team's REJECTED submissions per tile — display-only (the "redo this tile"
	// warning); does not affect completion (only approved + pending count toward `required`).
	rejectedByTile?: Record<string, number>;
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

export function swapPosKey(floor: number, section: DuoSection, step: number): string {
	return `${floor}:${section}:${step}`;
}

// The lane a team actually plays for a path position: the swapped-in lane if a swap was
// used at this (floor, section, step), else the lane they chose for the section.
function effectiveLane(
	inp: ProgressInput,
	floor: number,
	section: DuoSection,
	step: number,
	chosenLane: number
): number {
	return inp.swapByPositionKey?.[swapPosKey(floor, section, step)] ?? chosenLane;
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
		const chosen = inp.choiceByFloorSection[fsKey(stage.floor, stage.section!)];
		if (chosen === undefined) return false; // a section needs an explicit path choice
		for (let step = 0; step < DUO_SECTION_ROWS; step++) {
			const lane = effectiveLane(inp, stage.floor, stage.section!, step, chosen);
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
			const chosen = inp.choiceByFloorSection[fsKey(ref.floor, ref.section!)];
			// The lane actually played at this step (swapped-in lane if swapped, else chosen).
			const eff =
				chosen === undefined
					? undefined
					: effectiveLane(inp, ref.floor, ref.section!, ref.step!, chosen);
			if (si < currentStageIndex) {
				// Past section: the tiles actually taken (chosen lane, or a swapped-in lane for
				// swapped steps) read as complete; the paths NOT taken stay visible but greyed
				// (dimmed) — a finished floor shows the real tiles you skipped, not "?" blanks.
				state = eff !== undefined && ref.lane === eff ? 'complete' : 'dimmed';
			} else if (si === currentStageIndex) {
				if (chosen === undefined)
					state = 'choosable'; // all lanes shown so the team can compare + pick
				else if (ref.lane === eff) state = tileComplete(ref.id, inp) ? 'complete' : 'active';
				else state = 'dimmed'; // unchosen / swapped-away paths (still visible) — greyed
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
				required: inp.requiredByTile[ref.id] ?? 1,
				rejected: inp.rejectedByTile?.[ref.id] ?? 0
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
