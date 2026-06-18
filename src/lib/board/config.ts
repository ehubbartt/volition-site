// Client-safe shape of the DuoWolf board. Single source of truth for the node
// grid so the procedural topology (board/topology.ts), the server-only tile
// content (server/duoWolfTiles.ts), and server-side submission validation can
// never drift apart.
//
// NO tile names or FAQ live here — those are server-only (see
// server/duoWolfTiles.ts) so locked content never reaches the client.

export const DUO_FLOORS = 3;

// Parallel path choices per FLOOR (constant across that floor's sections).
// Floors 1 & 2 offer 3 paths; floor 3 offers 2 — matches the event sheet.
export const DUO_FLOOR_LANES = [3, 3, 2] as const;

// Each floor has three path SECTIONS (3-tile segments) separated by two
// intermission tiles, with DUO_SECTION_ROWS steps (tiles) down each path.
export const DUO_SECTIONS = ['A', 'B', 'C'] as const;
export type DuoSection = (typeof DUO_SECTIONS)[number];
export const DUO_SECTION_ROWS = 3;

// ---------------------------------------------------------------------------
// Canonical node-id builders — MUST match the ids produced by getBoardTopology
// in board/topology.ts.
// ---------------------------------------------------------------------------

export function duoStartId(floor: number): string {
	return `f${floor}-start`;
}

export function duoMidId(floor: number, section: DuoSection): string {
	return `f${floor}-mid-${section}`;
}

export function duoPathId(floor: number, section: DuoSection, lane: number, step: number): string {
	return `f${floor}-${section}-l${lane}-s${step}`;
}

export function duoBossId(floor: number): string {
	return `f${floor}-boss`;
}

export type DuoNodeKind = 'start' | 'mid' | 'path' | 'boss';

export interface DuoNodeRef {
	id: string;
	kind: DuoNodeKind;
	floor: number; // 1-based
	section?: DuoSection;
	lane?: number; // 0-based
	step?: number; // 0-based
	midIndex?: number; // 0 = mid after section A, 1 = mid after section B
}

// Parse a canonical node id back into its DuoNodeRef (inverse of the builders).
// Client-safe; used to map a clicked board node → floor/section for the path
// picker and progression logic. Returns null for an unrecognised id.
export function parseDuoNodeId(id: string): DuoNodeRef | null {
	let m = /^f(\d+)-start$/.exec(id);
	if (m) return { id, kind: 'start', floor: Number(m[1]) };
	m = /^f(\d+)-boss$/.exec(id);
	if (m) return { id, kind: 'boss', floor: Number(m[1]) };
	m = /^f(\d+)-mid-([A-C])$/.exec(id);
	if (m) {
		const section = m[2] as DuoSection;
		return { id, kind: 'mid', floor: Number(m[1]), section, midIndex: DUO_SECTIONS.indexOf(section) };
	}
	m = /^f(\d+)-([A-C])-l(\d+)-s(\d+)$/.exec(id);
	if (m) {
		return {
			id,
			kind: 'path',
			floor: Number(m[1]),
			section: m[2] as DuoSection,
			lane: Number(m[3]),
			step: Number(m[4])
		};
	}
	return null;
}

// Enumerate every content-bearing node id, in board order. Consumed by the
// server tile-content map and by submission validation.
export function duoNodeRefs(): DuoNodeRef[] {
	const out: DuoNodeRef[] = [];
	for (let f = 1; f <= DUO_FLOORS; f++) {
		const lanes = DUO_FLOOR_LANES[f - 1];
		out.push({ id: duoStartId(f), kind: 'start', floor: f });
		for (let s = 0; s < DUO_SECTIONS.length; s++) {
			const section = DUO_SECTIONS[s];
			for (let lane = 0; lane < lanes; lane++) {
				for (let step = 0; step < DUO_SECTION_ROWS; step++) {
					out.push({
						id: duoPathId(f, section, lane, step),
						kind: 'path',
						floor: f,
						section,
						lane,
						step
					});
				}
			}
			if (s < DUO_SECTIONS.length - 1) {
				out.push({ id: duoMidId(f, section), kind: 'mid', floor: f, section, midIndex: s });
			}
		}
		out.push({ id: duoBossId(f), kind: 'boss', floor: f });
	}
	return out;
}
