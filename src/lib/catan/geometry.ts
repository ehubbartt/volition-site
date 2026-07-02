// Hex-grid geometry for the Gielinor Catan board (pointy-top hexes, axial coords).
//
// Canonical ids — stable strings, safe to persist in the DB:
//   hex    "q,r"
//   vertex "q,r,N" | "q,r,S"   — every corner on a pointy-top grid is the north or
//                                south corner of exactly one hex (possibly off-board)
//   edge   "<vidA>|<vidB>"     — its two endpoint vertex ids, sorted
//
// Pure module (no imports): used by the server rules engine and the SVG board alike.

export interface Hex {
	q: number;
	r: number;
}

export type VertexId = string;
export type EdgeId = string;
export type HexId = string;

export function hexId(q: number, r: number): HexId {
	return `${q},${r}`;
}

export function parseHexId(id: HexId): Hex {
	const [q, r] = id.split(',').map(Number);
	return { q, r };
}

function vid(q: number, r: number, pole: 'N' | 'S'): VertexId {
	return `${q},${r},${pole}`;
}

export function parseVertexId(id: VertexId): { q: number; r: number; pole: 'N' | 'S' } {
	const [q, r, pole] = id.split(',');
	return { q: Number(q), r: Number(r), pole: pole as 'N' | 'S' };
}

/** All hexes of a hexagonal board with the given radius (radius 3 → 37 hexes). */
export function boardHexes(radius: number): Hex[] {
	const out: Hex[] = [];
	for (let q = -radius; q <= radius; q++) {
		for (let r = -radius; r <= radius; r++) {
			if (Math.max(Math.abs(q), Math.abs(r), Math.abs(q + r)) <= radius) out.push({ q, r });
		}
	}
	return out;
}

export function hexDistance(a: Hex, b: Hex): number {
	const dq = a.q - b.q;
	const dr = a.r - b.r;
	return (Math.abs(dq) + Math.abs(dr) + Math.abs(dq + dr)) / 2;
}

/** The 6 corners of a hex, clockwise from the top: N, NE, SE, S, SW, NW. */
export function hexCorners(h: Hex): VertexId[] {
	const { q, r } = h;
	return [
		vid(q, r, 'N'),
		vid(q + 1, r - 1, 'S'),
		vid(q, r + 1, 'N'),
		vid(q, r, 'S'),
		vid(q - 1, r + 1, 'N'),
		vid(q, r - 1, 'S')
	];
}

/** The 3 hexes that meet at a vertex (some may be off-board — filter against the board). */
export function vertexHexes(v: VertexId): Hex[] {
	const { q, r, pole } = parseVertexId(v);
	return pole === 'N'
		? [
				{ q, r },
				{ q: q + 1, r: r - 1 },
				{ q, r: r - 1 }
			]
		: [
				{ q, r },
				{ q, r: r + 1 },
				{ q: q - 1, r: r + 1 }
			];
}

/** The 3 vertices one edge away (N vertices neighbor only S vertices and vice versa). */
export function vertexNeighbors(v: VertexId): VertexId[] {
	const { q, r, pole } = parseVertexId(v);
	return pole === 'N'
		? [vid(q + 1, r - 1, 'S'), vid(q, r - 1, 'S'), vid(q + 1, r - 2, 'S')]
		: [vid(q, r + 1, 'N'), vid(q - 1, r + 1, 'N'), vid(q - 1, r + 2, 'N')];
}

export function edgeId(a: VertexId, b: VertexId): EdgeId {
	return a < b ? `${a}|${b}` : `${b}|${a}`;
}

export function edgeEndpoints(e: EdgeId): [VertexId, VertexId] {
	const [a, b] = e.split('|');
	return [a, b];
}

/** The 6 edges of a hex. */
export function hexEdges(h: Hex): EdgeId[] {
	const c = hexCorners(h);
	return c.map((v, i) => edgeId(v, c[(i + 1) % 6]));
}

/** The (up to 2) hexes an edge borders = intersection of its endpoints' hex triples. */
export function edgeHexes(e: EdgeId): Hex[] {
	const [a, b] = edgeEndpoints(e);
	const setA = new Set(vertexHexes(a).map((h) => hexId(h.q, h.r)));
	return vertexHexes(b).filter((h) => setA.has(hexId(h.q, h.r)));
}

/** The 3 edges that meet at a vertex. */
export function vertexEdges(v: VertexId): EdgeId[] {
	return vertexNeighbors(v).map((n) => edgeId(v, n));
}

/** Every distinct vertex of a board (radius 3 → 96). */
export function boardVertices(hexes: Hex[]): VertexId[] {
	const seen = new Set<VertexId>();
	for (const h of hexes) for (const v of hexCorners(h)) seen.add(v);
	return [...seen];
}

/** Every distinct edge of a board (radius 3 → 132). */
export function boardEdges(hexes: Hex[]): EdgeId[] {
	const seen = new Set<EdgeId>();
	for (const h of hexes) for (const e of hexEdges(h)) seen.add(e);
	return [...seen];
}

/** Coastal edges: edges bordering exactly one on-board hex, in clockwise coastal order. */
export function coastEdges(hexes: Hex[]): EdgeId[] {
	const onBoard = new Set(hexes.map((h) => hexId(h.q, h.r)));
	const coast = boardEdges(hexes).filter(
		(e) => edgeHexes(e).filter((h) => onBoard.has(hexId(h.q, h.r))).length === 1
	);
	// Order by angle around the board centre so port placement can space them evenly.
	return coast.sort((a, b) => edgeAngle(a) - edgeAngle(b));
}

function edgeAngle(e: EdgeId): number {
	const [a, b] = edgeEndpoints(e);
	const pa = vertexPos(a, 1);
	const pb = vertexPos(b, 1);
	return Math.atan2((pa.y + pb.y) / 2, (pa.x + pb.x) / 2);
}

// ---- pixel positions (pointy-top; y grows downward, matching SVG) ----

export function hexCenter(h: Hex, size: number): { x: number; y: number } {
	return {
		x: size * Math.sqrt(3) * (h.q + h.r / 2),
		y: size * 1.5 * h.r
	};
}

export function vertexPos(v: VertexId, size: number): { x: number; y: number } {
	const { q, r, pole } = parseVertexId(v);
	const c = hexCenter({ q, r }, size);
	return { x: c.x, y: c.y + (pole === 'N' ? -size : size) };
}

/** SVG polygon points for a hex outline. */
export function hexPolygonPoints(h: Hex, size: number): string {
	return hexCorners(h)
		.map((v) => {
			const p = vertexPos(v, size);
			return `${p.x.toFixed(2)},${p.y.toFixed(2)}`;
		})
		.join(' ');
}
