// Pure Connect Four rules — gravity, the pre-dealt tile deck, run detection and scoring.
// No DB access and no SvelteKit imports, so the server store, the admin tester and the
// simulation script all score a game identically.
//
// Two ideas carry the whole design:
//
//  1. THE BOARD IS A PURE FUNCTION OF THE PIECE LOG. Nothing about the game is stored
//     incrementally — not the scores, not which tile is live above a column, not the
//     winner. Every one of those is re-derived from the pieces on every read, which is
//     what makes an undo trivially correct and a double-credit impossible to "bank".
//
//  2. THE DECK IS DEALT UP FRONT. The curated pool is shuffled once at the start (seeded,
//     and the seed is stored), and column `c` owns the slice [c*ROWS, c*ROWS+ROWS). The
//     live tile above a column is therefore `deck[c*ROWS + piecesInColumn(c)]` — a
//     derivation, not a draw. "A new tile randomly replaces the completed one" is
//     satisfied by the shuffle, and there is no draw-time race to lose.
//
// Cells are 0-indexed `{ col, row }` with **row 0 at the BOTTOM** (pieces fall down onto
// row 0) and serialize to the string `"col,row"` — the identity the database's
// unique (event_id, cell) index uses. Never build a cell id by hand; use cellId/parseCell.

/** The board's dimensions. Fixed per game at creation; the classic board is 25×10. */
export interface BoardSize {
	cols: number;
	rows: number;
}

export const DEFAULT_SIZE: BoardSize = { cols: 25, rows: 10 };
export const COLS = DEFAULT_SIZE.cols;
export const ROWS = DEFAULT_SIZE.rows;
/** One curated tile per cell: filling the board consumes the whole deck. */
export const DECK_SIZE = COLS * ROWS;

export const deckSizeOf = (s: BoardSize): number => s.cols * s.rows;

export type Side = 1 | 2;
export type CellId = string;
export type Cell = { col: number; row: number };

/**
 * Coerce an admin-supplied (or stored) size into something playable. The bounds are
 * practical, not sacred: below them the game is over in minutes, above them the rail
 * stops being readable and the candidate universe can't fill the deck anyway.
 */
export function clampSize(input?: { cols?: unknown; rows?: unknown } | null): BoardSize {
	const n = (v: unknown, fallback: number, min: number, max: number) => {
		const x = Math.round(Number(v));
		return isFinite(x) ? Math.min(max, Math.max(min, x)) : fallback;
	};
	return {
		cols: n(input?.cols, DEFAULT_SIZE.cols, 5, 40),
		rows: n(input?.rows, DEFAULT_SIZE.rows, 4, 15)
	};
}

/**
 * A boss-drop objective. `item_id` is the match key; `source` is the boss, for display.
 * A NEGATIVE item_id marks a hand-added custom task: it exists so the curation UI can
 * key the tile, but it matches drops by NAME only (see matchesTile) and is projected to
 * the allowlist with a null id.
 */
export interface TileRef {
	item_id: number;
	item_name: string;
	source: string | null;
	/** Efficient hours to obtain — the difficulty weight the pool is curated by. */
	ehb?: number;
}

/** One claimed cell. The extras past col/row/side/deck_idx are display only. */
export interface Piece {
	col: number;
	row: number;
	side: Side;
	deck_idx: number;
	id?: string;
	item_id?: number | null;
	item_name?: string | null;
	source?: string | null;
	by_user_id?: string | null;
	by_rsn?: string | null;
	drop_key?: string;
	claimed_at?: string;
}

// ── Scoring configuration ───────────────────────────────────────────────────

/** What a run of exactly `len` is worth. Sorted ascending by `len`. */
export interface LineReward {
	len: number;
	points: number;
}

export interface Connect4Scoring {
	/** Paid per tile claimed. Set to 0 to score connect-fours only. */
	tile_points: number;
	/** Ascending by len; the first entry is the minimum scoring run (normally 4). */
	line_points: LineReward[];
	/** Paid per cell beyond the longest configured run, so the table needs no upper end. */
	extra_per_cell: number;
}

export const DEFAULT_SCORING: Connect4Scoring = {
	tile_points: 10,
	line_points: [
		{ len: 4, points: 100 },
		{ len: 5, points: 250 },
		{ len: 6, points: 500 },
		{ len: 7, points: 900 }
	],
	extra_per_cell: 400
};

export type Phase = 'setup' | 'live' | 'finished';

// ── Cell ids ────────────────────────────────────────────────────────────────

export function cellId(col: number, row: number): CellId {
	return `${col},${row}`;
}

/** `size: null` skips the bounds check — for display paths that serve any board. */
export function parseCell(id: CellId, size: BoardSize | null = DEFAULT_SIZE): Cell | null {
	const m = /^(\d+),(\d+)$/.exec(id);
	if (!m) return null;
	const col = Number(m[1]);
	const row = Number(m[2]);
	if (size && (col >= size.cols || row >= size.rows)) return null;
	return { col, row };
}

/** Spreadsheet-style label for the UI ("A1", "Y10") — display only, never an identity. */
export function cellLabel(id: CellId): string {
	const c = parseCell(id, null);
	if (!c) return id;
	return `${columnLabel(c.col)}${c.row + 1}`;
}

export function columnLabel(col: number): string {
	// 25 columns fit in A–Y, but keep the general form so a wider board can't break it.
	let n = col;
	let out = '';
	do {
		out = String.fromCharCode(65 + (n % 26)) + out;
		n = Math.floor(n / 26) - 1;
	} while (n >= 0);
	return out;
}

// ── Gravity ─────────────────────────────────────────────────────────────────

/** How many pieces each column holds, indexed by column. */
export function columnCounts(pieces: Piece[], size: BoardSize = DEFAULT_SIZE): number[] {
	const counts = new Array<number>(size.cols).fill(0);
	for (const p of pieces) {
		if (p.col >= 0 && p.col < size.cols) counts[p.col]++;
	}
	return counts;
}

/** The row a new piece would land on, or null if the column is full. */
export function landingRow(counts: number[], col: number, size: BoardSize = DEFAULT_SIZE): number | null {
	if (col < 0 || col >= size.cols) return null;
	const n = counts[col] ?? 0;
	return n >= size.rows ? null : n;
}

export function boardFull(pieces: Piece[], size: BoardSize = DEFAULT_SIZE): boolean {
	return pieces.length >= deckSizeOf(size);
}

/** Columns that can still take a piece. */
export function openColumns(counts: number[], size: BoardSize = DEFAULT_SIZE): number[] {
	const out: number[] = [];
	for (let c = 0; c < size.cols; c++) if ((counts[c] ?? 0) < size.rows) out.push(c);
	return out;
}

// ── The deck ────────────────────────────────────────────────────────────────

/** Which deck entry is live above a column that already holds `count` pieces. */
export function liveDeckIdx(col: number, count: number, size: BoardSize = DEFAULT_SIZE): number | null {
	if (col < 0 || col >= size.cols || count >= size.rows) return null;
	return col * size.rows + count;
}

export interface LiveTile {
	col: number;
	deckIdx: number;
	tile: TileRef;
}

/**
 * The 25 objectives currently on offer, one per column — `null` where a column has
 * filled up and retired. This is the ONLY definition of "what can be claimed right now";
 * the tracked-item rows handed to the Dink proxy are a projection of it, never a source.
 */
export function liveTiles(
	deck: TileRef[],
	pieces: Piece[],
	size: BoardSize = DEFAULT_SIZE
): (LiveTile | null)[] {
	const counts = columnCounts(pieces, size);
	const out: (LiveTile | null)[] = [];
	for (let col = 0; col < size.cols; col++) {
		const idx = liveDeckIdx(col, counts[col] ?? 0, size);
		const tile = idx === null ? undefined : deck[idx];
		out.push(idx === null || !tile ? null : { col, deckIdx: idx, tile });
	}
	return out;
}

/**
 * Does a drop satisfy a tile? Item id first, name as the fallback — matchTracked's rule.
 * A tile with a NEGATIVE item_id is a hand-added custom task whose id is synthetic, so
 * it never id-matches — the name is its whole identity.
 */
export function matchesTile(
	drop: { item_id?: number | null; item_name?: string | null },
	tile: TileRef
): boolean {
	if (drop.item_id != null && tile.item_id != null && tile.item_id > 0) {
		return Number(drop.item_id) === Number(tile.item_id);
	}
	const a = (drop.item_name ?? '').trim().toLowerCase();
	const b = (tile.item_name ?? '').trim().toLowerCase();
	return a.length > 0 && a === b;
}

/** Fisher–Yates against a caller-supplied RNG, so a seeded deal is reproducible. */
export function shuffleDeck(pool: TileRef[], rand: () => number): TileRef[] {
	const out = pool.slice();
	for (let i = out.length - 1; i > 0; i--) {
		const j = Math.floor(rand() * (i + 1));
		[out[i], out[j]] = [out[j], out[i]];
	}
	return out;
}

/** Mulberry32 — a small seeded RNG so the deal (and the simulation) can be replayed. */
export function seededRandom(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

// ── Runs ────────────────────────────────────────────────────────────────────

export type Direction = 'h' | 'v' | 'd1' | 'd2';

const STEPS: Record<Direction, [number, number]> = {
	h: [1, 0],
	v: [0, 1],
	d1: [1, 1],
	d2: [1, -1]
};

export interface Run {
	side: Side;
	dir: Direction;
	cells: CellId[];
	len: number;
}

/**
 * Every MAXIMAL same-side run of at least `minLen`, in all four directions.
 *
 * Maximal matters: a run of six contains three overlapping windows of four, and counting
 * those separately would pay three times for one line. A run is emitted only from its
 * true start (the cell before it, in that direction, is not the same side), so each line
 * appears exactly once at its full length. Two runs crossing at a cell are different
 * directions and score separately — a cross is genuinely two lines.
 */
export function findRuns(pieces: Piece[], minLen = 4): Run[] {
	const bySide = new Map<CellId, Side>();
	for (const p of pieces) bySide.set(cellId(p.col, p.row), p.side);

	const runs: Run[] = [];
	for (const p of pieces) {
		for (const dir of Object.keys(STEPS) as Direction[]) {
			const [dc, dr] = STEPS[dir];
			// Only start from the beginning of a line, or the same run emits once per cell.
			if (bySide.get(cellId(p.col - dc, p.row - dr)) === p.side) continue;
			const cells: CellId[] = [];
			let col = p.col;
			let row = p.row;
			while (bySide.get(cellId(col, row)) === p.side) {
				cells.push(cellId(col, row));
				col += dc;
				row += dr;
			}
			if (cells.length >= minLen) runs.push({ side: p.side, dir, cells, len: cells.length });
		}
	}
	return runs;
}

/** The runs a given cell belongs to — what the board celebrates after a claim. */
export function runsThrough(runs: Run[], cell: CellId): Run[] {
	return runs.filter((r) => r.cells.includes(cell));
}

/** Every cell that is part of any scoring run, for highlighting. */
export function runCellSet(runs: Run[]): Set<CellId> {
	const out = new Set<CellId>();
	for (const r of runs) for (const c of r.cells) out.add(c);
	return out;
}

// ── Scoring ─────────────────────────────────────────────────────────────────

/** The shortest run that scores at all — normally 4. */
export function minScoringLen(s: Connect4Scoring): number {
	return s.line_points.length ? Math.min(...s.line_points.map((r) => r.len)) : 4;
}

/**
 * What a run of `len` pays: the largest configured tier at or below it, plus
 * `extra_per_cell` for every cell past the top of the table. Extending a line pays the
 * difference automatically, because standings are always recomputed from scratch — a
 * 4-run that becomes a 5-run stops paying the 4-tier and starts paying the 5-tier.
 */
export function pointsFor(len: number, s: Connect4Scoring): number {
	const tiers = s.line_points.filter((r) => r.len <= len);
	if (!tiers.length) return 0;
	const best = tiers.reduce((a, b) => (b.len > a.len ? b : a));
	const top = Math.max(...s.line_points.map((r) => r.len));
	const beyond = len > top ? (len - top) * (s.extra_per_cell || 0) : 0;
	return best.points + beyond;
}

export interface SideStanding {
	side: Side;
	tiles: number;
	tilePoints: number;
	linePoints: number;
	total: number;
	runs: Run[];
	/** Longest run this side holds, 0 if none. */
	longest: number;
}

export function sideStanding(pieces: Piece[], side: Side, s: Connect4Scoring): SideStanding {
	const mine = pieces.filter((p) => p.side === side);
	const runs = findRuns(pieces, minScoringLen(s)).filter((r) => r.side === side);
	const tilePoints = mine.length * (s.tile_points || 0);
	const linePoints = runs.reduce((sum, r) => sum + pointsFor(r.len, s), 0);
	return {
		side,
		tiles: mine.length,
		tilePoints,
		linePoints,
		total: tilePoints + linePoints,
		runs,
		longest: runs.reduce((m, r) => Math.max(m, r.len), 0)
	};
}

export function standings(pieces: Piece[], s: Connect4Scoring): SideStanding[] {
	return [sideStanding(pieces, 1, s), sideStanding(pieces, 2, s)];
}

/** Who is ahead. `null` on a tie — a drawn game is a real outcome, not a missing one. */
export function leaderOf(pieces: Piece[], s: Connect4Scoring): Side | null {
	const [a, b] = standings(pieces, s);
	if (a.total === b.total) return null;
	return a.total > b.total ? 1 : 2;
}

// ── Validation helpers ──────────────────────────────────────────────────────

export function isSide(v: unknown): v is Side {
	return v === 1 || v === 2;
}

/** Normalizes an admin-supplied scoring form into something the rules can score with. */
export function normalizeScoring(input: Partial<Connect4Scoring> | null | undefined): Connect4Scoring {
	const src = input ?? {};
	const rewards = (Array.isArray(src.line_points) ? src.line_points : DEFAULT_SCORING.line_points)
		.map((r) => ({ len: Math.max(2, Math.round(Number(r?.len) || 0)), points: Math.round(Number(r?.points) || 0) }))
		.filter((r) => r.len >= 2)
		.sort((a, b) => a.len - b.len);
	// Deduplicate on len, keeping the last write — an admin editing a row shouldn't be
	// able to leave two conflicting entries for the same length behind.
	const byLen = new Map<number, LineReward>();
	for (const r of rewards) byLen.set(r.len, r);
	return {
		tile_points: Math.max(0, Math.round(Number(src.tile_points ?? DEFAULT_SCORING.tile_points) || 0)),
		line_points: [...byLen.values()].sort((a, b) => a.len - b.len),
		extra_per_cell: Math.max(0, Math.round(Number(src.extra_per_cell ?? DEFAULT_SCORING.extra_per_cell) || 0))
	};
}
