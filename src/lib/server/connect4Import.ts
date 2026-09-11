// Parse a curated tile list (CSV) into a Connect Four pool.
//
// The event's tiles are planned in a spreadsheet — 244 distinct tiles that expand,
// via a per-tile copy count, into exactly one tile per board cell. Adding those by
// hand is not a realistic ask, so this turns the exported CSV into the game's custom
// tile list and its pool in one go.
//
// Every imported tile is a CUSTOM tile (a synthetic negative id, matched by name),
// because these are hand-written objectives — "Any Barrows Body", "Mixology Points" —
// not entries in the generated boss-drop universe. That is also why no item-allowlist
// is built: this event is reviewed by hand, so the NAME is the specification and a
// human decides whether the proof meets it.

import type { TileRef } from '$lib/connect4/rules';
import planned from './data/connect4PlannedTiles.json';

export interface ImportedTile {
	name: string;
	source: string | null;
	content: string | null;
	/** How many are needed to finish the tile. 1 = a single drop. */
	qty: number;
	/** Expected hours to complete — shown as the tile's difficulty. */
	hours: number | null;
	/** Anything qualifying that the name doesn't already say. */
	included: string[];
	/** How many board cells this tile occupies. */
	copies: number;
	tier: string | null;
	/** Highlighted in the planning sheet as needing a BEFORE screenshot. */
	pre?: boolean;
	/** The parenthetical the sheet sometimes adds, e.g. "on banked unsireds". */
	preNote?: string;
}

export interface ImportReport {
	tiles: ImportedTile[];
	/** Total board cells the import would fill (the sum of every tile's copies). */
	cells: number;
	/** Problems that would make the import wrong, rather than merely odd. */
	errors: string[];
	/** Things worth telling the admin, which do not block the import. */
	warnings: string[];
}

/** Header aliases, so the sheet's own wording imports without being edited first. */
const COLUMNS: Record<string, string[]> = {
	name: ['tile', 'tile name', 'name'],
	source: ['source in game', 'source', 'boss', 'boss/source'],
	content: ['content type', 'content', 'type'],
	qty: ['quantity required', 'quantity required to complete tile', 'quantity', 'qty', 'required'],
	hours: ['expected hours', 'expected tile completion time in hours', 'hours', 'ehb'],
	// The sheet's own spelling of this one is a typo; accept it as-is.
	included: ['included items', 'inlcluded items', 'included items (only if not already included in tile name)',
		'inlcluded items (only if not already included in tile name)', 'included'],
	copies: ['how many copies of this tile on board', 'copies', 'copies on board'],
	tier: ['tier', 'difficulty', 'requirements']
};

/**
 * Read a whole CSV into records. NOT line-by-line: a quoted field may contain
 * newlines, and the planning sheet's notes column does — splitting on \n first
 * tears one record into pieces and every column after it lands in the wrong place.
 */
function parseCsv(text: string): string[][] {
	const rows: string[][] = [];
	let row: string[] = [];
	let cur = '';
	let quoted = false;
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		if (quoted) {
			if (ch === '"') {
				if (text[i + 1] === '"') {
					cur += '"';
					i++;
				} else quoted = false;
			} else cur += ch;
		} else if (ch === '"') quoted = true;
		else if (ch === ',') {
			row.push(cur);
			cur = '';
		} else if (ch === '\r') {
			// swallow; the \n that follows ends the record
		} else if (ch === '\n') {
			row.push(cur);
			rows.push(row);
			row = [];
			cur = '';
		} else cur += ch;
	}
	row.push(cur);
	rows.push(row);
	return rows.map((r) => r.map((c) => c.trim()));
}

const norm = (h: string) => h.toLowerCase().replace(/\s+/g, ' ').trim();

/** One table of tiles found in the sheet: where its columns are, and its tier. */
interface Block {
	at: Record<string, number>;
	tier: string | null;
}

/**
 * Find the tile tables in a header record. The planning sheet is not one table: it
 * lays the LOW, MEDIUM and HIGH tiers out side by side, each with its own copy of the
 * same headings, with a stats panel to their left and a spacer column between them.
 * So every "Tile" heading starts a block, and that block owns the columns up to the
 * next one — which also makes a plain single-table CSV just a file with one block.
 */
function blocksOf(
	header: string[],
	banner: string[] | undefined,
	known: Map<number, string>
): Block[] {
	const starts: number[] = [];
	header.forEach((h, i) => {
		if (COLUMNS.name.includes(norm(h))) starts.push(i);
	});
	return starts.map((start, n) => {
		const end = starts[n + 1] ?? header.length;
		const at: Record<string, number> = {};
		for (const [field, names] of Object.entries(COLUMNS)) {
			at[field] = -1;
			for (let i = start; i < end; i++) {
				if (names.includes(norm(header[i]))) {
					at[field] = i;
					break;
				}
			}
		}
		// The tier is written once, above the block, as a banner ("High Requirements
		// /PvM Skill…") rather than per row — so read it off the row above. The FIRST
		// banner wins: the sheet repeats its header partway down, and that second
		// banner labels all three blocks "Low" (a copy-paste slip in the source), so
		// re-reading it would relabel every medium and high tile.
		let tier = known.get(start) ?? null;
		for (let i = start; i >= 0 && banner && !tier; i--) {
			const m = /\b(low|medium|high)\b/i.exec(banner[i] ?? '');
			if (m) {
				tier = m[1][0].toUpperCase() + m[1].slice(1).toLowerCase();
				break;
			}
			if (banner[i]) break; // some other label — not this block's banner
		}
		if (tier) known.set(start, tier);
		return { at, tier };
	});
}

const intOr = (v: string, d: number): number => {
	const n = Number(String(v).replace(/[, ]/g, ''));
	return Number.isFinite(n) && n > 0 ? Math.round(n) : d;
};

export function parseTileCsv(text: string): ImportReport {
	const errors: string[] = [];
	const warnings: string[] = [];
	const rows = parseCsv(text).filter((r) => r.some((c) => c));
	if (rows.length < 2) return { tiles: [], cells: 0, errors: ['That file has no rows in it'], warnings };

	const tiles: ImportedTile[] = [];
	const seen = new Map<string, number>();
	let blocks: Block[] = [];
	let sawHeader = false;
	const tierByStart = new Map<number, string>();

	// Walk the sheet top to bottom. A record that carries a "Tile" heading REDEFINES
	// the layout from there down — the export repeats its header partway through, and
	// re-reading it is what keeps the rows below aligned.
	rows.forEach((cells, i) => {
		const isHeader = cells.some((c) => COLUMNS.name.includes(norm(c)));
		if (isHeader) {
			blocks = blocksOf(cells, rows[i - 1], tierByStart);
			if (blocks.length > 1 && !sawHeader) {
				warnings.push(`Read ${blocks.length} tier blocks laid out side by side.`);
			}
			sawHeader = true;
			return;
		}
		if (!blocks.length) return; // still above the header — stats, notes, banners

		for (const { at, tier } of blocks) {
			const get = (f: string) => (at[f] >= 0 ? (cells[at[f]] ?? '') : '');
			const name = get('name');
			if (!name) continue; // this block has no tile on this row

			// The sheet's stats panel sits in the same columns as the first block, so
			// "Total Low Tiles" and friends land in a Tile cell and would import as
			// tiles. A planned tile always says how many cells it takes; a summary row
			// leaves that blank, which is the difference between them.
			if (at.copies >= 0) {
				if (!get('copies')) continue;
			} else if (!get('source') && !get('hours')) continue;

			const rowNo = i + 1;
			const prior = seen.get(name.toLowerCase());
			if (prior) {
				// Two rows for one tile is almost always a copy-paste slip; the copies
				// column is how a tile appears more than once, so flag rather than merge.
				warnings.push(`Row ${rowNo}: "${name}" also appears on row ${prior} — imported twice.`);
			}
			seen.set(name.toLowerCase(), rowNo);

			const hoursRaw = Number(get('hours'));
			tiles.push({
				name,
				source: get('source') || null,
				content: get('content') || null,
				qty: intOr(get('qty'), 1),
				hours: Number.isFinite(hoursRaw) && hoursRaw > 0 ? Math.round(hoursRaw * 100) / 100 : null,
				included: get('included')
					? get('included').split(/[,/]/).map((s) => s.trim()).filter(Boolean)
					: [],
				copies: intOr(get('copies'), 1),
				tier: get('tier') || tier
			});
		}
	});

	if (!sawHeader) {
		const seenCols = rows[0].filter(Boolean).join(', ');
		return {
			tiles: [],
			cells: 0,
			errors: [
				`No "Tile" column found anywhere in that file. The first row reads: ${seenCols || '(blank)'}`
			],
			warnings
		};
	}
	if (!tiles.length) errors.push('Found the header, but no tile rows under it');
	for (const need of ['copies', 'qty'] as const) {
		if (blocks.length && blocks.every((b) => b.at[need] < 0)) {
			warnings.push(`No "${need}" column — defaulting every tile to 1.`);
		}
	}
	const cells = tiles.reduce((n, t) => n + t.copies, 0);
	return { tiles, cells, errors, warnings };
}

/**
 * Expand the parsed tiles into the pool: one entry per board cell, each copy of a tile
 * repeating the same TileRef. Synthetic ids run downward from -1 so they can never
 * collide with a real item id, matching `addCustomTile`.
 *
 * Returns the custom list (for the game's candidate strip) and the pool in one shape,
 * because they are written together — importing 244 tiles one call at a time would be
 * 244 round trips and a half-finished board if any of them failed.
 */
export function toPoolAndCustom(tiles: ImportedTile[]): { custom: TileRef[]; pool: TileRef[] } {
	const custom: TileRef[] = [];
	const pool: TileRef[] = [];
	tiles.forEach((t, i) => {
		const ref: TileRef = {
			item_id: -(i + 1),
			item_name: t.name,
			source: t.source,
			ehb: t.hours ?? 0,
			...(t.qty > 1 ? { qty: t.qty } : {}),
			...(t.included.length
				? { any_of: t.included.map((n) => ({ item_id: null, item_name: n })) }
				: {}),
			...(t.pre ? { pre_shot: true } : {}),
			...(t.preNote ? { pre_note: t.preNote } : {})
		};
		custom.push(ref);
		for (let c = 0; c < t.copies; c++) pool.push(ref);
	});
	return { custom, pool };
}

/**
 * THE PLANNED BOARD, checked in.
 *
 * The event runs on one specific 600-cell list designed in `Tile_Planning.xlsx`, so
 * that list lives in the repo (`data/connect4PlannedTiles.json`, generated from the
 * sheet by `parseTileCsv`) rather than being re-uploaded from a spreadsheet export
 * every time a game is set up. An admin gets the exact tiles in one click, and a
 * malformed export can no longer stand between them and a working board.
 *
 * Regenerate it from a new sheet export with:
 *   node scripts/build_planned_tiles.mjs <export.csv>
 */
export function plannedTiles(): ImportedTile[] {
	return (planned.list as ImportedTile[]).map((t) => ({ ...t, included: [...t.included] }));
}

/** What the built-in list adds up to — the admin UI says this before it is used. */
export const PLANNED_SUMMARY = { tiles: planned.tiles, cells: planned.cells };
