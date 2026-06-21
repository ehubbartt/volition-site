// SERVER-ONLY: DB overlay for DuoWolf board tile content.
//
// The tile getters in duoWolfTiles.ts read an in-memory map (`activeTiles`) that starts as
// the hardcoded defaults. This module loads the admin overrides from vs_duo_tiles and merges
// them over the defaults (applyDuoTileOverrides), keeping a short-TTL cache so the SYNC getters
// keep working: any async caller that's about to read tile content should
// `await ensureDuoTilesFresh()` first. Writes (saveDuoTile/resetDuoTile) force an immediate
// refresh so the editing admin sees their change at once; other server instances pick it up
// within the TTL.

import { db } from '$lib/server/db';
import { applyDuoTileOverrides, DUO_TILE_IDS, type DuoTileOverrideRow } from '$lib/server/duoWolfTiles';

const SELECT = 'node_id, name, img, required, faq, pre_pic, pre_pic_post_required, auto_clear';
const TTL_MS = 10_000;

let lastRefresh = 0;
let inflight: Promise<void> | null = null;

async function doRefresh(): Promise<void> {
	const { data, error } = await db().from('vs_duo_tiles').select(SELECT);
	if (error) {
		// Table may not exist yet (migration applied by hand) — keep the code defaults and
		// don't hammer the DB; treat as "fresh" so we back off for the TTL window.
		console.warn('[duoTiles] override load failed (using defaults):', error.message);
		lastRefresh = Date.now();
		return;
	}
	applyDuoTileOverrides((data ?? []) as DuoTileOverrideRow[]);
	lastRefresh = Date.now();
}

// Ensure the live tile map reflects the DB overrides. Cheap: no-ops within the TTL window and
// de-dupes concurrent refreshes. Call before reading the sync tile getters in any async path.
export async function ensureDuoTilesFresh(force = false): Promise<void> {
	if (!force && Date.now() - lastRefresh < TTL_MS) return;
	if (inflight) return inflight;
	inflight = doRefresh().finally(() => {
		inflight = null;
	});
	return inflight;
}

// The set of node ids that currently have an override row (for the editor's "edited" badge +
// "reset" affordance).
export async function listDuoTileOverrideIds(): Promise<Set<string>> {
	const { data, error } = await db().from('vs_duo_tiles').select('node_id');
	if (error) return new Set();
	return new Set((data ?? []).map((r: { node_id: string }) => r.node_id));
}

export interface SaveDuoTileInput {
	node_id: string;
	name: string;
	img: string;
	required: number;
	faq: string;
	pre_pic: boolean;
	pre_pic_post_required: boolean;
	auto_clear: string | null;
	updated_by: string | null;
}

// Upsert a tile override (one row per node id) and refresh the live map immediately.
export async function saveDuoTile(input: SaveDuoTileInput): Promise<{ ok: boolean; error?: string }> {
	if (!DUO_TILE_IDS.has(input.node_id)) return { ok: false, error: 'Unknown tile' };
	const { error } = await db()
		.from('vs_duo_tiles')
		.upsert(
			{
				node_id: input.node_id,
				name: input.name,
				img: input.img,
				required: Math.max(1, Math.floor(input.required) || 1),
				faq: input.faq,
				pre_pic: input.pre_pic,
				pre_pic_post_required: input.pre_pic && input.pre_pic_post_required,
				auto_clear: input.auto_clear,
				updated_by: input.updated_by,
				updated_at: new Date().toISOString()
			},
			{ onConflict: 'node_id' }
		);
	if (error) return { ok: false, error: error.message };
	await ensureDuoTilesFresh(true);
	return { ok: true };
}

// Drop a tile's override row, reverting it to the hardcoded default. Refreshes immediately.
export async function resetDuoTile(nodeId: string): Promise<{ ok: boolean; error?: string }> {
	if (!DUO_TILE_IDS.has(nodeId)) return { ok: false, error: 'Unknown tile' };
	const { error } = await db().from('vs_duo_tiles').delete().eq('node_id', nodeId);
	if (error) return { ok: false, error: error.message };
	await ensureDuoTilesFresh(true);
	return { ok: true };
}
