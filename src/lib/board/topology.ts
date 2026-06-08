import {
	DUO_FLOORS,
	DUO_FLOOR_LANES,
	DUO_SECTION_ROWS,
	DUO_SECTIONS,
	duoBossId,
	duoMidId,
	duoPathId,
	duoStartId
} from './config';

export type NodeKind = 'start' | 'community' | 'path' | 'boss';

export interface BoardNode {
	id: string;
	kind: NodeKind;
	floor: number;
	section?: 'A' | 'B' | 'C';
	lane?: number;
	step?: number;
	x: number;
	y: number;
}

export interface BoardEdge {
	id: string;
	from: string;
	to: string;
	interFloor?: boolean;
}

export interface FloorBand {
	floor: number;
	ways: number;
	y: number;
	height: number;
	label: string;
}

export interface BoardTopology {
	nodes: BoardNode[];
	edges: BoardEdge[];
	floors: FloorBand[];
	viewBox: { w: number; h: number };
}

const VIEW_WIDTH = 600;
const CENTER_X = VIEW_WIDTH / 2;
const LANE_GAP = 124;
const ROW_GAP = 92;
const FLOOR_HEADER = 56;
const FLOOR_GAP = 100;

export function getBoardTopology(): BoardTopology {
	const nodes: BoardNode[] = [];
	const edges: BoardEdge[] = [];
	const floors: FloorBand[] = [];

	let cursorY = 0;

	for (let f = 0; f < DUO_FLOORS; f++) {
		const floor = f + 1;
		const bandTop = cursorY;
		cursorY += FLOOR_HEADER;

		// Lane count is constant across a floor's sections (3 / 3 / 2 per floor).
		const lanes = DUO_FLOOR_LANES[f];
		const laneXs: number[] = [];
		for (let lane = 0; lane < lanes; lane++) {
			const offset = (lane - (lanes - 1) / 2) * LANE_GAP;
			laneXs.push(CENTER_X + offset);
		}

		const startId = duoStartId(floor);
		nodes.push({
			id: startId,
			kind: floor === 1 ? 'start' : 'community',
			floor,
			x: CENTER_X,
			y: cursorY
		});
		let prevExitId = startId;
		cursorY += ROW_GAP;

		for (let s = 0; s < DUO_SECTIONS.length; s++) {
			const section = DUO_SECTIONS[s];
			const isLast = s === DUO_SECTIONS.length - 1;

			const sectionTopIds: string[] = [];
			const sectionBotIds: string[] = [];

			for (let step = 0; step < DUO_SECTION_ROWS; step++) {
				for (let lane = 0; lane < lanes; lane++) {
					const id = duoPathId(floor, section, lane, step);
					nodes.push({
						id,
						kind: 'path',
						floor,
						section,
						lane,
						step,
						x: laneXs[lane],
						y: cursorY
					});
					if (step === 0) sectionTopIds.push(id);
					if (step === DUO_SECTION_ROWS - 1) sectionBotIds.push(id);
				}
				cursorY += ROW_GAP;
			}

			for (const topId of sectionTopIds) {
				edges.push({ id: `${prevExitId}->${topId}`, from: prevExitId, to: topId });
			}
			for (let lane = 0; lane < lanes; lane++) {
				for (let step = 0; step < DUO_SECTION_ROWS - 1; step++) {
					const a = duoPathId(floor, section, lane, step);
					const b = duoPathId(floor, section, lane, step + 1);
					edges.push({ id: `${a}->${b}`, from: a, to: b });
				}
			}

			if (!isLast) {
				const midId = duoMidId(floor, section);
				nodes.push({ id: midId, kind: 'community', floor, x: CENTER_X, y: cursorY });
				for (const botId of sectionBotIds) {
					edges.push({ id: `${botId}->${midId}`, from: botId, to: midId });
				}
				prevExitId = midId;
				cursorY += ROW_GAP;
			} else {
				const bossId = duoBossId(floor);
				nodes.push({ id: bossId, kind: 'boss', floor, x: CENTER_X, y: cursorY });
				for (const botId of sectionBotIds) {
					edges.push({ id: `${botId}->${bossId}`, from: botId, to: bossId });
				}
				cursorY += FLOOR_GAP;
			}
		}

		floors.push({
			floor,
			ways: lanes,
			y: bandTop,
			height: cursorY - bandTop,
			label: `Floor ${floor}`
		});
	}

	for (let f = 0; f < DUO_FLOORS - 1; f++) {
		const fromId = duoBossId(f + 1);
		const toId = duoStartId(f + 2);
		edges.push({ id: `${fromId}->${toId}`, from: fromId, to: toId, interFloor: true });
	}

	return {
		nodes,
		edges,
		floors,
		viewBox: { w: VIEW_WIDTH, h: cursorY }
	};
}
