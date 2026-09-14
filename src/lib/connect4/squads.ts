// Internal teams ("squads") — one clan's own split of ONE side into Red/Blue/Yellow, and
// how the points that side has already scored are re-attributed to them.
//
// Pure, like rules.ts: no DB and no SvelteKit imports, so the server builds the payload
// and the page re-derives standings from it with the same code. That matters because the
// board's own standings are computed client-side from the piece log (see the member page),
// and a squad table lagging a beat behind the scoreboard beside it would look broken.
//
// THE MODEL, in one line: a squad never owns a cell — it owns a SHARE of one.
//
//   - A ×1 tile is wholly the claimant's, so their squad takes 100% of it.
//   - A ×N tile is a group effort, so each contributor's share is their banked qty over
//     the side's total banked qty for that slot. Two players who each banked 500 toward a
//     1,000 tile take half a tile each, and if they are on different squads the tile's
//     points split down the middle.
//   - A LINE is worth the same to the side however it was built, so its points are split
//     evenly across its cells first and each cell's slice is then split by that cell's own
//     contribution shares. A four built by four different squads pays each a quarter.
//   - A pet is one player's, so its bonus goes whole to their squad.
//
// Contributions that resolve to nobody — a hand-credited piece with no claimant, a player
// never assigned a squad — go to the UNASSIGNED bucket rather than being dropped, so the
// squad totals always add back up to what the side's own scoreboard says.
//
// Nothing here can change the clan-vs-clan game. Squad standings are a re-reading of
// points already banked; no squad claims a cell, wins a tile or moves a side's total.

import { cellId, pointsFor, type Connect4Scoring, type Piece, type Run, type Side } from './rules';

/** The key used for contributions belonging to no squad. Never a real row. */
export const UNASSIGNED = '';

export interface SquadDef {
	key: string;
	name: string;
	color: string;
}

/**
 * Display for the squad keys an event uses. Deliberately NOT the side colours
 * (#ef4444 / #eab308): a squad ring is drawn around a disc already painted in its side's
 * colour, so it needs its own brighter register to read at all. The dark separator the
 * board draws between disc and ring is what keeps the yellow squad legible on the yellow
 * side.
 */
export const SQUAD_PALETTE: Record<string, { name: string; color: string }> = {
	red: { name: 'Red Team', color: '#ff5a4d' },
	blue: { name: 'Blue Team', color: '#4d9bff' },
	yellow: { name: 'Yellow Team', color: '#ffd24d' },
	green: { name: 'Green Team', color: '#3ddc84' },
	purple: { name: 'Purple Team', color: '#c07dff' },
	orange: { name: 'Orange Team', color: '#ff9c3d' },
	cyan: { name: 'Cyan Team', color: '#3ddbdb' },
	pink: { name: 'Pink Team', color: '#ff7ab8' }
};

/** Handed out, in order, to a squad key the palette has never seen. */
const SPARE_COLORS = ['#3ddc84', '#c07dff', '#ff9c3d', '#3ddbdb', '#ff7ab8', '#a3b18a'];

/** Grey, and named for what it is — an unassigned player is a gap, not a fourth team. */
export const UNASSIGNED_DEF: SquadDef = { key: UNASSIGNED, name: 'No team', color: '#8a8f98' };

/**
 * Turn the squad keys present on an event into something renderable. An unknown key gets
 * a title-cased label and the next spare colour, so a fourth squad is rows in the
 * database and no code change at all.
 */
export function squadDefs(keys: string[]): SquadDef[] {
	let spare = 0;
	return keys.map((key) => {
		const known = SQUAD_PALETTE[key.toLowerCase()];
		if (known) return { key, name: known.name, color: known.color };
		return {
			key,
			name: key.replace(/(^|\s)\S/g, (m) => m.toUpperCase()),
			color: SPARE_COLORS[spare++ % SPARE_COLORS.length]
		};
	});
}

/** One contributor's slice of one cell. A cell's shares sum to 1. */
export interface CellShare {
	/** Squad key, or UNASSIGNED. */
	key: string;
	share: number;
}

/**
 * What the server hands the page. `cells` covers only the squad side's own claimed cells;
 * the opposing clan's pieces have no shares and are never ringed.
 */
export interface SquadView {
	/** The side these squads divide up. The other side has no squads and never sees this. */
	side: Side;
	squads: SquadDef[];
	/** Cell id ("col,row") → who banked it, proportionally. */
	cells: Record<string, CellShare[]>;
	/** Squad key per member of that side, for the bonus split and the roster counts. */
	members: Record<string, string>;
	/** The viewer's own squad key, or null if they are on the side but unassigned. */
	viewerSquad: string | null;
}

export interface SquadStanding extends SquadDef {
	tilePoints: number;
	linePoints: number;
	bonusPoints: number;
	/**
	 * How many awards, as distinct from what they paid. Both are needed: the points go into
	 * the total, and "5 pets" is what a player wants to read. Conflating them showed a team
	 * with five pets as having fifty, because pet_points is 10.
	 */
	bonusCount: number;
	total: number;
	/** Fractional — half of a ×N tile really is half a tile. */
	tiles: number;
	/** Roster size. Zero on the unassigned bucket, which counts contributions not people. */
	members: number;
}

/**
 * Re-attribute one side's score to its squads.
 *
 * `runs` comes from the caller because the page has already found them for the board's own
 * highlight — running the line finder a second time over 600 cells on every poll would be
 * the one expensive thing in an otherwise cheap derivation. It may therefore describe more
 * of the board than `pieces` does, which is why a run only pays once every one of its
 * cells is on show.
 *
 * `pieces` is the board AS SHOWN (the playback slice), so a replay's squad table fills in
 * as the discs land instead of jumping to the final numbers on the first frame.
 *
 * Every squad on the roster gets a row, including one that has scored nothing —
 * "Yellow Team: 0" is information, and a missing row reads as a bug.
 */
export function squadStandings(
	view: SquadView,
	runs: Run[],
	scoring: Connect4Scoring,
	bonus: { side: Side; points: number; byUserId: string | null }[],
	pieces: Piece[]
): SquadStanding[] {
	type Acc = { tile: number; line: number; bonus: number; tiles: number; awards: number };
	const blank = (): Acc => ({ tile: 0, line: 0, bonus: 0, tiles: 0, awards: 0 });
	const acc = new Map<string, Acc>();
	const bump = (key: string, field: 'tile' | 'line' | 'bonus', amount: number, tiles = 0) => {
		const row = acc.get(key) ?? blank();
		row[field] += amount;
		row.tiles += tiles;
		if (field === 'bonus') row.awards++;
		acc.set(key, row);
	};

	const shown = new Set<string>();
	for (const p of pieces) if (p.side === view.side) shown.add(cellId(p.col, p.row));

	// A cell of the right side with no recorded shares is still that side's cell, so it
	// goes to the unassigned bucket rather than quietly leaving the totals short.
	const sharesOf = (cell: string): CellShare[] => {
		const s = view.cells[cell];
		return s?.length ? s : [{ key: UNASSIGNED, share: 1 }];
	};

	const tilePts = scoring.tile_points || 0;
	for (const cell of shown) {
		for (const s of sharesOf(cell)) bump(s.key, 'tile', tilePts * s.share, s.share);
	}

	for (const run of runs) {
		if (run.side !== view.side) continue;
		// A PARTIALLY REVEALED LINE IS NOT A LINE. `runs` is found over the whole board, so
		// during a replay it already knows about fours whose last disc has not landed yet;
		// paying their visible cells would have the squad table crediting a line the board
		// beside it is not showing, and the totals would jump backwards when it finally
		// completed. All four cells on show, or the run pays nothing.
		if (!run.cells.every((c) => shown.has(c))) continue;
		const per = pointsFor(run.len, scoring) / run.len;
		for (const cell of run.cells) {
			for (const s of sharesOf(cell)) bump(s.key, 'line', per * s.share);
		}
	}

	for (const b of bonus) {
		if (b.side !== view.side) continue;
		bump((b.byUserId && view.members[b.byUserId]) || UNASSIGNED, 'bonus', b.points);
	}

	const headcount = new Map<string, number>();
	for (const key of Object.values(view.members)) {
		headcount.set(key, (headcount.get(key) ?? 0) + 1);
	}

	return [...view.squads, UNASSIGNED_DEF]
		.map((def) => {
			const row = acc.get(def.key) ?? blank();
			return {
				...def,
				tilePoints: row.tile,
				linePoints: row.line,
				bonusPoints: row.bonus,
				bonusCount: row.awards,
				total: row.tile + row.line + row.bonus,
				tiles: row.tiles,
				members: headcount.get(def.key) ?? 0
			};
		})
		// The unassigned bucket is noise until it holds something; a real squad with nothing
		// yet still gets its row.
		.filter((s) => s.key !== UNASSIGNED || s.total > 0 || s.tiles > 0)
		.sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));
}

/**
 * The ring a cell gets on the board: its shares, largest first, as CSS conic-gradient
 * stops over one full turn. Null for a cell nobody on the squad side holds.
 */
export function ringStops(
	shares: CellShare[] | undefined,
	colorOf: (key: string) => string
): string | null {
	if (!shares?.length) return null;
	const sorted = [...shares].sort((a, b) => b.share - a.share);
	let at = 0;
	const out: string[] = [];
	for (const s of sorted) {
		const end = Math.min(1, at + Math.max(0, s.share));
		out.push(`${colorOf(s.key)} ${(at * 360).toFixed(2)}deg ${(end * 360).toFixed(2)}deg`);
		at = end;
	}
	// Rounding can leave a hairline at the end of the sweep; close it with the last colour.
	if (at < 1 && out.length) {
		out.push(`${colorOf(sorted[sorted.length - 1].key)} ${(at * 360).toFixed(2)}deg 360deg`);
	}
	return out.join(', ');
}
