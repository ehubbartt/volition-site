// SERVER-ONLY data layer for the data-driven Event Builder (bingo first).
//
// Bingo structure + tile content used to be hardcoded in $lib/server/bingoTiles.ts
// and $lib/bingo/config.ts. This module reads a built event's structure from
// vs_events.structure and its tiles from vs_event_tiles, falling back to the
// hardcoded code defaults when an event has no tiles stored (so the legacy
// echo-rumors event, and any not-yet-built event, keep working unchanged).
//
// It also owns the builder mutations (clone a template, edit/delete tiles, update
// structure) and the per-event tracked-items CRUD that feeds the Dink auto-tracker.

import { db } from '$lib/server/db';
import {
	BINGO_EVENT_SLUG,
	DEFAULT_BINGO_STRUCTURE,
	normalizeBingoStructure,
	type BingoStructure,
	type BingoTierConfig
} from '$lib/bingo/config';
import { BINGO_TILES, getTileDetails } from '$lib/server/bingoTiles';
import type { BingoTier, BingoTile } from '$lib/bingo/tiles';

export interface EventTileRow {
	tile_id: string;
	row: number;
	tier: string;
	name: string;
	points: number;
	details_md: string | null;
	img: string | null;
}

export interface TrackedItemRow {
	id: string;
	event_id: string;
	tile_id: string;
	item_id: number | null;
	item_name: string;
	required_qty: number;
	source_name: string | null;
	match_type: string; // 'loot' | 'collection'
}

export interface EventBoard {
	// `built` = this event has its own tiles in vs_event_tiles (created via the
	// builder). false = falling back to the hardcoded code defaults.
	built: boolean;
	structure: BingoStructure;
	tiles: BingoTile[];
	getDetails: (tileId: string) => string | null;
}

// Generate a BLANK grid of tiles for a structure: one empty tile per
// (row × main column) plus a bonus tile per row when the bonus column is on.
// Names/details are empty — a cloned template gives admins an empty board of the
// right shape to fill in, NOT the content of a past bingo.
export function generateBlankTiles(structure: BingoStructure): EventTileRow[] {
	const out: EventTileRow[] = [];
	const mainTiers = structure.tiers.filter((t) => t.key !== 'bonus');
	const bonusTier = structure.tiers.find((t) => t.key === 'bonus');
	for (let r = 1; r <= structure.rowCount; r++) {
		for (const t of mainTiers) {
			out.push({ tile_id: `r${r}-${t.key}`, row: r, tier: t.key, name: '', points: t.points, details_md: null, img: null });
		}
		if (structure.bonusEnabled && bonusTier) {
			out.push({ tile_id: `b${r}`, row: r, tier: 'bonus', name: '', points: bonusTier.points, details_md: null, img: null });
		}
	}
	return out;
}

// Registry of built-in, clonable templates. Tile content for built-ins is
// generated from code; user-saved templates live in vs_event_templates.
const BUILTIN_TEMPLATES: Record<
	string,
	{ name: string; kind: string; structure: BingoStructure; tiles: () => EventTileRow[] }
> = {
	[BINGO_EVENT_SLUG]: {
		name: 'Blank bingo (Echo Rumors shape)',
		kind: 'bingo',
		structure: DEFAULT_BINGO_STRUCTURE,
		// Blank grid of the default shape — admins fill in the tiles themselves.
		tiles: () => generateBlankTiles(DEFAULT_BINGO_STRUCTURE)
	}
};

function rowsToTiles(rows: EventTileRow[]): BingoTile[] {
	return rows
		.slice()
		.sort((a, b) => a.row - b.row || a.tier.localeCompare(b.tier))
		.map((r) => ({
			id: r.tile_id,
			name: r.name,
			tier: r.tier as BingoTier,
			row: r.row,
			points: r.points,
			img: r.img
		}));
}

const DEFAULT_DETAILS = 'Screenshot of the new collection log or the untradeable loot notification.';

// Load the renderable board for an event row (must include id, slug, structure).
export async function loadEventBoard(event: {
	id: string;
	slug: string;
	structure?: unknown;
}): Promise<EventBoard> {
	const structure = normalizeBingoStructure(event.structure);

	const { data, error } = await db()
		.from('vs_event_tiles')
		.select('tile_id, row, tier, name, points, details_md, img')
		.eq('event_id', event.id);

	if (error) {
		// Table may not exist yet (manual migration) — fall back to code defaults.
		console.warn('[eventStructure] tile load failed (using code defaults):', error.message);
	}

	const rows = (data ?? []) as EventTileRow[];

	if (rows.length > 0) {
		const detailsById = new Map(rows.map((r) => [r.tile_id, r.details_md]));
		return {
			built: true,
			structure,
			tiles: rowsToTiles(rows),
			getDetails: (id) => detailsById.get(id) ?? DEFAULT_DETAILS
		};
	}

	// No built tiles → legacy/built-in code defaults (echo-rumors), else empty.
	const builtin = BUILTIN_TEMPLATES[event.slug];
	if (builtin) {
		return {
			built: false,
			structure,
			tiles: BINGO_TILES,
			getDetails: (id) => getTileDetails(id)
		};
	}
	return { built: false, structure, tiles: [], getDetails: () => DEFAULT_DETAILS };
}

// ── Builder mutations ───────────────────────────────────────────────────────

// Clone a template's structure + tiles into an event (idempotent-ish: replaces the
// event's tiles). Built-in templates generate tiles from code; otherwise read the
// saved template row. Returns the structure written to vs_events.structure.
export async function cloneTemplateToEvent(
	eventId: string,
	templateSlug: string
): Promise<{ ok: boolean; error?: string }> {
	let structure: BingoStructure;
	let tiles: EventTileRow[];

	const builtin = BUILTIN_TEMPLATES[templateSlug];
	if (builtin) {
		structure = builtin.structure;
		tiles = builtin.tiles();
	} else {
		const { data, error } = await db()
			.from('vs_event_templates')
			.select('structure, tiles')
			.eq('slug', templateSlug)
			.maybeSingle();
		if (error) return { ok: false, error: error.message };
		if (!data) return { ok: false, error: 'Template not found' };
		structure = normalizeBingoStructure(data.structure);
		tiles = (Array.isArray(data.tiles) ? data.tiles : []) as EventTileRow[];
	}

	const { error: structErr } = await db()
		.from('vs_events')
		.update({ structure })
		.eq('id', eventId);
	if (structErr) return { ok: false, error: structErr.message };

	// Replace any existing tiles for a clean clone.
	await db().from('vs_event_tiles').delete().eq('event_id', eventId);

	if (tiles.length) {
		const rows = tiles.map((t) => ({
			event_id: eventId,
			tile_id: t.tile_id,
			row: t.row,
			tier: t.tier,
			name: t.name,
			points: t.points,
			details_md: t.details_md ?? null,
			img: t.img ?? null
		}));
		const { error: insErr } = await db().from('vs_event_tiles').insert(rows);
		if (insErr) return { ok: false, error: insErr.message };
	}

	return { ok: true };
}

export async function updateEventStructure(
	eventId: string,
	structure: BingoStructure
): Promise<{ ok: boolean; error?: string }> {
	const normalized = normalizeBingoStructure(structure);
	const { error } = await db().from('vs_events').update({ structure: normalized }).eq('id', eventId);
	if (error) return { ok: false, error: error.message };
	// Reconcile the tile grid to the new shape: add blank tiles for any new
	// (row × column) or bonus cell, and delete tiles whose row/column no longer
	// exists (e.g. bonus turned off, or rows reduced). Existing tile content is
	// preserved — only missing/removed ids change.
	await syncEventGrid(eventId, normalized);
	return { ok: true };
}

// Ensure vs_event_tiles matches the structure's desired (row × column + bonus)
// set: insert blanks for missing ids, delete ids no longer in the grid.
export async function syncEventGrid(eventId: string, structure: BingoStructure): Promise<void> {
	const desired = generateBlankTiles(structure);
	const desiredIds = new Set(desired.map((d) => d.tile_id));

	const { data: existing, error } = await db()
		.from('vs_event_tiles')
		.select('tile_id')
		.eq('event_id', eventId);
	if (error) return; // table missing / transient — skip silently
	const existingIds = new Set((existing ?? []).map((r) => (r as { tile_id: string }).tile_id));

	const toInsert = desired
		.filter((d) => !existingIds.has(d.tile_id))
		.map((d) => ({ event_id: eventId, ...d }));
	if (toInsert.length) await db().from('vs_event_tiles').insert(toInsert);

	const toDelete = [...existingIds].filter((id) => !desiredIds.has(id));
	if (toDelete.length) {
		await db().from('vs_event_tiles').delete().eq('event_id', eventId).in('tile_id', toDelete);
	}
}

export interface SaveEventTileInput {
	event_id: string;
	tile_id: string;
	row: number;
	tier: string;
	name: string;
	points: number;
	details_md: string | null;
	img: string | null;
}

export async function saveEventTile(input: SaveEventTileInput): Promise<{ ok: boolean; error?: string }> {
	if (!input.tile_id.trim()) return { ok: false, error: 'Tile id required' };
	const { error } = await db()
		.from('vs_event_tiles')
		.upsert(
			{
				event_id: input.event_id,
				tile_id: input.tile_id.trim(),
				row: Math.max(1, Math.floor(input.row) || 1),
				tier: input.tier,
				name: input.name.trim(),
				points: Math.max(0, Math.floor(input.points) || 0),
				details_md: input.details_md?.trim() || null,
				img: input.img?.trim() || null
			},
			{ onConflict: 'event_id,tile_id' }
		);
	return error ? { ok: false, error: error.message } : { ok: true };
}

export async function deleteEventTile(eventId: string, tileId: string): Promise<{ ok: boolean; error?: string }> {
	const { error } = await db().from('vs_event_tiles').delete().eq('event_id', eventId).eq('tile_id', tileId);
	return error ? { ok: false, error: error.message } : { ok: true };
}

// ── Tracked items (Dink auto-tracking) ──────────────────────────────────────

export async function listTrackedItems(eventId: string): Promise<TrackedItemRow[]> {
	const { data, error } = await db()
		.from('vs_event_tracked_items')
		.select('id, event_id, tile_id, item_id, item_name, required_qty, source_name, match_type')
		.eq('event_id', eventId)
		.order('tile_id', { ascending: true });
	if (error) {
		console.warn('[eventStructure] tracked item load failed:', error.message);
		return [];
	}
	return (data ?? []) as TrackedItemRow[];
}

export async function saveTrackedItem(input: {
	event_id: string;
	tile_id: string;
	item_id: number | null;
	item_name: string;
	required_qty: number;
	source_name: string | null;
	match_type?: string;
}): Promise<{ ok: boolean; error?: string }> {
	if (!input.tile_id.trim()) return { ok: false, error: 'Tile id required' };
	if (!input.item_name.trim()) return { ok: false, error: 'Item name required' };
	const matchType = input.match_type === 'collection' ? 'collection' : 'loot';
	const { error } = await db().from('vs_event_tracked_items').insert({
		event_id: input.event_id,
		tile_id: input.tile_id.trim(),
		item_id: input.item_id,
		item_name: input.item_name.trim(),
		required_qty: Math.max(1, Math.floor(input.required_qty) || 1),
		source_name: input.source_name?.trim() || null,
		match_type: matchType
	});
	return error ? { ok: false, error: error.message } : { ok: true };
}

export async function deleteTrackedItem(id: string): Promise<{ ok: boolean; error?: string }> {
	const { error } = await db().from('vs_event_tracked_items').delete().eq('id', id);
	return error ? { ok: false, error: error.message } : { ok: true };
}

export function listTemplates(): { slug: string; name: string; kind: string; tiers: BingoTierConfig[] }[] {
	return Object.entries(BUILTIN_TEMPLATES).map(([slug, t]) => ({
		slug,
		name: t.name,
		kind: t.kind,
		tiers: t.structure.tiers
	}));
}
