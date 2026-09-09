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

/** Split a CSV line, honouring quoted fields (names contain commas). */
function splitCsvLine(line: string): string[] {
	const out: string[] = [];
	let cur = '';
	let quoted = false;
	for (let i = 0; i < line.length; i++) {
		const ch = line[i];
		if (quoted) {
			if (ch === '"') {
				if (line[i + 1] === '"') {
					cur += '"';
					i++;
				} else quoted = false;
			} else cur += ch;
		} else if (ch === '"') quoted = true;
		else if (ch === ',') {
			out.push(cur);
			cur = '';
		} else cur += ch;
	}
	out.push(cur);
	return out.map((s) => s.trim());
}

const intOr = (v: string, d: number): number => {
	const n = Number(String(v).replace(/[, ]/g, ''));
	return Number.isFinite(n) && n > 0 ? Math.round(n) : d;
};

export function parseTileCsv(text: string): ImportReport {
	const errors: string[] = [];
	const warnings: string[] = [];
	const lines = text.split(/\r?\n/).filter((l) => l.trim());
	if (lines.length < 2) return { tiles: [], cells: 0, errors: ['That file has no rows in it'], warnings };

	const header = splitCsvLine(lines[0]).map((h) => h.toLowerCase().replace(/\s+/g, ' ').trim());
	const at: Record<string, number> = {};
	for (const [field, names] of Object.entries(COLUMNS)) {
		at[field] = header.findIndex((h) => names.includes(h));
	}
	if (at.name < 0) {
		return {
			tiles: [],
			cells: 0,
			errors: [`No "Tile" column found. Columns seen: ${header.join(', ')}`],
			warnings
		};
	}
	for (const need of ['copies', 'qty'] as const) {
		if (at[need] < 0) warnings.push(`No "${need}" column — defaulting every tile to 1.`);
	}

	const tiles: ImportedTile[] = [];
	const seen = new Map<string, number>();
	lines.slice(1).forEach((line, i) => {
		const cell = splitCsvLine(line);
		const get = (f: string) => (at[f] >= 0 ? (cell[at[f]] ?? '') : '');
		const name = get('name');
		if (!name) return; // blank row, or a spacer between the sheet's blocks

		const rowNo = i + 2;
		const prior = seen.get(name.toLowerCase());
		if (prior) {
			// Two rows for one tile is almost always a copy-paste slip; the copies column
			// is how a tile appears more than once, so flag rather than silently merge.
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
			tier: get('tier') || null
		});
	});

	if (!tiles.length) errors.push('No tile rows found below the header');
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
				: {})
		};
		custom.push(ref);
		for (let c = 0; c < t.copies; c++) pool.push(ref);
	});
	return { custom, pool };
}
