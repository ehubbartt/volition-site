// Pure Battleship rules — board sizing, fleet composition, placement validation, bomb
// footprints and hit resolution. No DB access and no SvelteKit imports, so the server
// store, the admin tester and the player board all score a game the same way, and the
// simulation script can drive a whole game without a browser.
//
// Coordinates are 0-indexed `{ x, y }` (x = column, y = row) and serialize to the
// string `"x,y"` — the form stored in vs_battleship_shots.cell and in a ship's `cells`,
// so the database's unique (event_id, target_side, cell) index is the same identity the
// rules use. Never build a cell id by hand; go through cellId/parseCell.

export type Cell = { x: number; y: number };
export type CellId = string;

export type Orientation = 'h' | 'v';

export interface Ship {
	id: string;
	name: string;
	len: number;
	cells: CellId[];
}

/** A bomb tier: what a drop is worth and how big a hole it makes. */
export interface Tier {
	tier: number;
	name: string;
	/** Minimum single-stack gp value of a drop to earn this tier. */
	min_value: number;
	/** Footprint is `span` x `span`, anchored at its top-left cell. */
	span: number;
}

export interface BattleshipConfig {
	size: number;
	tiers: Tier[];
	/** Minutes between the draft completing and the battle opening. */
	placement_minutes: number;
}

export type Phase = 'setup' | 'signup' | 'draft' | 'placement' | 'battle' | 'finished';

// ── Cell ids ────────────────────────────────────────────────────────────────

export function cellId(x: number, y: number): CellId {
	return `${x},${y}`;
}

export function parseCell(id: CellId): Cell | null {
	const m = /^(\d+),(\d+)$/.exec(id);
	if (!m) return null;
	return { x: Number(m[1]), y: Number(m[2]) };
}

/** Spreadsheet-style label for the UI ("A1", "J10") — display only, never an identity. */
export function cellLabel(id: CellId): string {
	const c = parseCell(id);
	if (!c) return id;
	return `${columnLabel(c.x)}${c.y + 1}`;
}

export function columnLabel(x: number): string {
	// A..Z then AA.. — boards never get that wide, but don't produce '[' at x=26.
	let out = '';
	let n = x;
	do {
		out = String.fromCharCode(65 + (n % 26)) + out;
		n = Math.floor(n / 26) - 1;
	} while (n >= 0);
	return out;
}

// ── Board sizing ────────────────────────────────────────────────────────────

export const MIN_SIZE = 8;
/**
 * The widest board we serve. 25 is the largest grid that still reads as a board rather
 * than a spreadsheet: it fits a desktop viewport at a comfortable cell size, and on a
 * phone it scrolls inside its own box against the tap-target floor (see BoardGrid).
 * Beyond this the fix is a longer event, not more water.
 */
export const MAX_SIZE = 25;
/**
 * Water per player on a side — the dial that sets how long an event lasts.
 *
 * Bombs arrive in proportion to headcount, so board area has to scale with headcount too
 * or a big event just saturates its board. The first pass used 6, which put 16-a-side on
 * the classic 10x10 — but the 60-player rehearsal needed 185 shots on a 196-square board
 * to finish, i.e. it ran until the board was nearly all craters. Real players hunt around
 * their hits rather than firing at random, so they would have got there far sooner.
 *
 * 15 is set from the event we are actually running: 80 players, 40 a side, on a 25x25
 * board (625 squares). It keeps the classic 10x10 for a 12-player game and lands 60
 * players on 22x22. At a rough 1 qualifying drop per player per day that is a week-ish of
 * play rather than a day or two. It is a guess against unmeasured drop rates — raise it if
 * events end too quickly, and note an admin can always pin an exact size when creating
 * the event.
 */
const CELLS_PER_PLAYER = 15;

/**
 * Board edge for a given per-side headcount. Deliberately a function of TEAM size, not
 * total signups, so an uneven draft (odd pool) doesn't give one side a different board.
 * Callers pass the larger side.
 */
export function boardSizeFor(perSide: number): number {
	const n = Math.ceil(Math.sqrt(Math.max(1, perSide) * CELLS_PER_PLAYER));
	return Math.min(MAX_SIZE, Math.max(MIN_SIZE, n));
}

// ── Fleet ───────────────────────────────────────────────────────────────────

/** Share of the water that is ship. 0.17 is the classic 10x10 ratio (17 of 100). */
const FLEET_DENSITY = 0.17;
/** Repeating ship-length pattern; one full cycle is the classic fleet. */
const LENGTH_PATTERN = [5, 4, 3, 3, 2];

const CLASS_BY_LEN: Record<number, string> = {
	5: 'Carrier',
	4: 'Battleship',
	3: 'Cruiser',
	2: 'Destroyer'
};

/**
 * Roman numeral for a ship's ordinal. A 25x25 board carries twelve Cruisers, so a
 * fixed list ran out and left "Cruiser X" sitting next to "Cruiser 11".
 */
function roman(n: number): string {
	const table: [number, string][] = [
		[40, 'XL'], [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']
	];
	let out = '';
	let left = n;
	for (const [value, sym] of table) {
		while (left >= value) {
			out += sym;
			left -= value;
		}
	}
	return out;
}

/**
 * The fleet a board of this size gets: ship LENGTHS, descending. Cycles the classic
 * pattern until the fleet covers ~FLEET_DENSITY of the water, so a 10x10 board is
 * exactly the classic 5/4/3/3/2 and bigger boards stay at the same density rather
 * than becoming a needle hunt.
 */
export function fleetLengthsFor(size: number): number[] {
	const target = Math.round(size * size * FLEET_DENSITY);
	const lengths: number[] = [];
	let total = 0;
	for (let i = 0; total < target; i++) {
		const len = LENGTH_PATTERN[i % LENGTH_PATTERN.length];
		// Never let a ship exceed the board edge (only reachable at absurdly small sizes).
		if (len > size) continue;
		lengths.push(len);
		total += len;
	}
	return lengths.sort((a, b) => b - a);
}

/** Empty (unplaced) fleet for a board size — ids and display names, no cells yet. */
export function emptyFleet(size: number): Ship[] {
	const lengths = fleetLengthsFor(size);
	const seen = new Map<number, number>();
	return lengths.map((len, i) => {
		const nth = (seen.get(len) ?? 0) + 1;
		seen.set(len, nth);
		const cls = CLASS_BY_LEN[len] ?? `Ship-${len}`;
		return {
			id: `s${i + 1}`,
			name: cls + (nth > 1 ? ` ${roman(nth)}` : ''),
			len,
			cells: []
		};
	});
}

// ── Tiers ───────────────────────────────────────────────────────────────────

/**
 * Default bomb tiers. The 5m floor is deliberately above the 3m `minLootValue` that
 * multi-server Dink members are pinned to (see docs/event-builder-and-dink-tracking.md),
 * so they need no config change to play. All three are admin-tunable per event.
 */
export const DEFAULT_TIERS: Tier[] = [
	{ tier: 1, name: 'Cannonball', min_value: 5_000_000, span: 1 },
	{ tier: 2, name: 'Bombard', min_value: 20_000_000, span: 2 },
	{ tier: 3, name: 'Broadside', min_value: 60_000_000, span: 3 }
];

/** The best tier a drop of this value earns, or null if it's under the lowest floor. */
export function tierForValue(value: number, tiers: Tier[] = DEFAULT_TIERS): Tier | null {
	let best: Tier | null = null;
	for (const t of tiers) {
		if (value >= t.min_value && (!best || t.min_value > best.min_value)) best = t;
	}
	return best;
}

// ── Placement ───────────────────────────────────────────────────────────────

/** The cells a ship of `len` occupies from an anchor, or null if it leaves the board. */
export function shipCells(
	anchor: Cell,
	len: number,
	orient: Orientation,
	size: number
): CellId[] | null {
	const cells: CellId[] = [];
	for (let i = 0; i < len; i++) {
		const x = anchor.x + (orient === 'h' ? i : 0);
		const y = anchor.y + (orient === 'v' ? i : 0);
		if (x < 0 || y < 0 || x >= size || y >= size) return null;
		cells.push(cellId(x, y));
	}
	return cells;
}

export type PlacementError =
	| { ok: true }
	| { ok: false; reason: 'off_board' | 'overlap' | 'wrong_length' | 'not_contiguous' };

/**
 * Validate one ship's cells against the board and the ships already placed.
 * Touching hulls are LEGAL (standard rules) — only overlap is rejected.
 */
export function validatePlacement(
	ship: Pick<Ship, 'len' | 'cells'>,
	others: Ship[],
	size: number
): PlacementError {
	if (ship.cells.length !== ship.len) return { ok: false, reason: 'wrong_length' };

	const pts: Cell[] = [];
	for (const id of ship.cells) {
		const c = parseCell(id);
		if (!c || c.x < 0 || c.y < 0 || c.x >= size || c.y >= size) return { ok: false, reason: 'off_board' };
		pts.push(c);
	}

	// Contiguous and axis-aligned: all-same-row with consecutive x, or all-same-column
	// with consecutive y. Guards a hand-built payload, not the UI.
	const sameRow = pts.every((p) => p.y === pts[0].y);
	const sameCol = pts.every((p) => p.x === pts[0].x);
	if (!sameRow && !sameCol) return { ok: false, reason: 'not_contiguous' };
	const axis = sameRow ? pts.map((p) => p.x) : pts.map((p) => p.y);
	axis.sort((a, b) => a - b);
	for (let i = 1; i < axis.length; i++) {
		if (axis[i] !== axis[i - 1] + 1) return { ok: false, reason: 'not_contiguous' };
	}

	const taken = new Set(others.flatMap((s) => s.cells));
	for (const id of ship.cells) if (taken.has(id)) return { ok: false, reason: 'overlap' };

	return { ok: true };
}

/** Every ship placed, the right length, and no overlaps — i.e. the fleet may lock. */
export function fleetComplete(fleet: Ship[], size: number): boolean {
	if (fleet.length === 0) return false;
	const placed: Ship[] = [];
	for (const s of fleet) {
		if (validatePlacement(s, placed, size).ok !== true) return false;
		placed.push(s);
	}
	return true;
}

/**
 * Deterministic auto-placement — used by the admin tester's "Auto-place", by the
 * simulation, and as the fallback for a side that never placed before the deadline
 * (a side with no fleet can't be shot at, which would stall the whole event).
 * `rand` is injected so a seeded run is reproducible.
 */
export function autoPlace(size: number, rand: () => number = Math.random): Ship[] {
	const fleet = emptyFleet(size);
	const placed: Ship[] = [];
	for (const ship of fleet) {
		let done = false;
		// Bounded attempts, then an exhaustive sweep, so this can never spin forever
		// on a dense board.
		for (let attempt = 0; attempt < 500 && !done; attempt++) {
			const orient: Orientation = rand() < 0.5 ? 'h' : 'v';
			const span = size - ship.len;
			const anchor = {
				x: Math.floor(rand() * (orient === 'h' ? span + 1 : size)),
				y: Math.floor(rand() * (orient === 'v' ? span + 1 : size))
			};
			const cells = shipCells(anchor, ship.len, orient, size);
			if (!cells) continue;
			if (validatePlacement({ len: ship.len, cells }, placed, size).ok !== true) continue;
			ship.cells = cells;
			done = true;
		}
		if (!done) {
			outer: for (let y = 0; y < size; y++) {
				for (let x = 0; x < size; x++) {
					for (const orient of ['h', 'v'] as Orientation[]) {
						const cells = shipCells({ x, y }, ship.len, orient, size);
						if (!cells) continue;
						if (validatePlacement({ len: ship.len, cells }, placed, size).ok !== true) continue;
						ship.cells = cells;
						done = true;
						break outer;
					}
				}
			}
		}
		if (!done) throw new Error(`autoPlace: no room for ${ship.name} (${ship.len}) on ${size}x${size}`);
		placed.push(ship);
	}
	return fleet;
}

// ── Firing ──────────────────────────────────────────────────────────────────

/**
 * The cells a bomb covers, anchored at its TOP-LEFT for every tier (1x1, 2x2, 3x3 all
 * anchor the same way, so the UI preview is one rule). Returns null when the footprint
 * would leave the board — the whole bomb must fit, which is still enough to reach every
 * cell including the corners.
 */
export function bombCells(anchor: Cell, span: number, size: number): CellId[] | null {
	if (anchor.x < 0 || anchor.y < 0) return null;
	if (anchor.x + span > size || anchor.y + span > size) return null;
	const cells: CellId[] = [];
	for (let dy = 0; dy < span; dy++) {
		for (let dx = 0; dx < span; dx++) cells.push(cellId(anchor.x + dx, anchor.y + dy));
	}
	return cells;
}

/** Largest legal anchor for a span — what the UI clamps a drag to. */
export function maxAnchor(span: number, size: number): number {
	return Math.max(0, size - span);
}

/**
 * The top-left anchor for a bomb of `span` aimed AT `cell`, clamped so the whole
 * footprint stays on the board.
 *
 * Aiming is centred, not corner-based: you point at the square you want to hit and the
 * blast wraps around it. A 3x3 puts the clicked square in the middle; a 2x2 has no middle
 * square, so the click becomes its top-left. Either way **the square you clicked is always
 * inside the footprint**, which is the property that makes aiming predictable.
 *
 * Storage is unchanged — vs_battleship_shots still records the top-left anchor, and
 * `bombCells` still expands from it. This is only the click-to-anchor translation, and it
 * lives here so the hover preview, the committed highlight and the shot that is actually
 * fired can never disagree about it.
 */
export function anchorFor(cell: Cell, span: number, size: number): Cell {
	const off = Math.floor((span - 1) / 2);
	const max = maxAnchor(span, size);
	const clamp = (n: number) => Math.min(Math.max(n - off, 0), max);
	return { x: clamp(cell.x), y: clamp(cell.y) };
}

export interface ShotResult {
	cell: CellId;
	hit: boolean;
	shipId: string | null;
	/** True when THIS shot completed the ship. */
	sunk: boolean;
}

export interface FireOutcome {
	cells: ShotResult[];
	/** Cells that were already craters — skipped, not double-counted. */
	skipped: CellId[];
	hits: number;
	sunkShipIds: string[];
	/** Every ship of the target side is now sunk. */
	defeated: boolean;
}

/**
 * Resolve a bomb against a side's fleet given the cells already fired at it.
 *
 * `alreadyFired` is the authority on what has been hit before — the caller passes the
 * rows from vs_battleship_shots, so this stays pure and the database's unique index
 * stays the single source of truth for "fired once".
 */
export function resolveFire(
	fleet: Ship[],
	alreadyFired: Set<CellId>,
	bomb: CellId[]
): FireOutcome {
	const shipByCell = new Map<CellId, Ship>();
	for (const s of fleet) for (const c of s.cells) shipByCell.set(c, s);

	const fired = new Set(alreadyFired);
	const cells: ShotResult[] = [];
	const skipped: CellId[] = [];

	for (const cell of bomb) {
		if (fired.has(cell)) {
			skipped.push(cell);
			continue;
		}
		fired.add(cell);
		const ship = shipByCell.get(cell) ?? null;
		cells.push({ cell, hit: !!ship, shipId: ship?.id ?? null, sunk: false });
	}

	// Sink check AFTER every cell of this bomb is applied, so a bomb that finishes a
	// ship across two of its own cells reports one sink, on the last cell.
	const sunkShipIds: string[] = [];
	for (const s of fleet) {
		if (s.cells.length === 0) continue;
		if (!s.cells.every((c) => fired.has(c))) continue;
		// Only NEW sinks: it must not have been fully hit before this bomb.
		if (s.cells.every((c) => alreadyFired.has(c))) continue;
		sunkShipIds.push(s.id);
		for (let i = cells.length - 1; i >= 0; i--) {
			if (cells[i].shipId === s.id) {
				cells[i].sunk = true;
				break;
			}
		}
	}

	const defeated =
		fleet.length > 0 && fleet.every((s) => s.cells.length > 0 && s.cells.every((c) => fired.has(c)));

	return { cells, skipped, hits: cells.filter((c) => c.hit).length, sunkShipIds, defeated };
}

// ── Standings ───────────────────────────────────────────────────────────────

export interface SideStanding {
	side: number;
	name: string;
	/** Shots this side has FIRED (cells), and how they landed. */
	shotsFired: number;
	hits: number;
	misses: number;
	accuracy: number;
	/** Enemy ships this side has sunk. */
	sunk: number;
	/** Ship cells still afloat on THIS side's own board. */
	afloat: number;
	totalCells: number;
	/** This side's own ships fully sunk. */
	lost: number;
	bombsUnspent: number;
}

export function sideStanding(input: {
	side: number;
	name: string;
	ownFleet: Ship[];
	/** Cells fired at THIS side. */
	incoming: Set<CellId>;
	/** Cells THIS side fired at the enemy, with their hit flag. */
	outgoing: { cell: CellId; hit: boolean }[];
	/** Enemy ships this side's shots have sunk. */
	sunkEnemyShips: number;
	bombsUnspent: number;
}): SideStanding {
	const totalCells = input.ownFleet.reduce((n, s) => n + s.cells.length, 0);
	const hitCells = input.ownFleet.reduce(
		(n, s) => n + s.cells.filter((c) => input.incoming.has(c)).length,
		0
	);
	const hits = input.outgoing.filter((o) => o.hit).length;
	const shotsFired = input.outgoing.length;
	return {
		side: input.side,
		name: input.name,
		shotsFired,
		hits,
		misses: shotsFired - hits,
		accuracy: shotsFired ? hits / shotsFired : 0,
		sunk: input.sunkEnemyShips,
		afloat: totalCells - hitCells,
		totalCells,
		lost: input.ownFleet.filter((s) => s.cells.length > 0 && s.cells.every((c) => input.incoming.has(c))).length,
		bombsUnspent: input.bombsUnspent
	};
}

// ── Draft ───────────────────────────────────────────────────────────────────

/**
 * Whose pick it is, given how many have been made. Plain alternating (side 1, side 2,
 * side 1 …) from `firstSide` — the literal "two captains each pick from the pool until
 * everyone is picked". With an odd pool the side picking first ends up one player larger.
 */
export function draftTurn(picksMade: number, firstSide: 1 | 2 = 1): 1 | 2 {
	const other: 1 | 2 = firstSide === 1 ? 2 : 1;
	return picksMade % 2 === 0 ? firstSide : other;
}
