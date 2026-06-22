// SERVER-ONLY consumer for the Dink auto-tracking pipeline.
//
// The dink-proxy Worker matches qualifying LOOT drops (player ∈ clan/event,
// item ∈ an event's tracked items) and writes them to vs_dink_drops. This module
// drains that table and auto-credits the matching bingo tile by inserting an
// already-APPROVED vs_bingo_completions row (matching how a manually-approved
// submission credits a tile + the leaderboard). Idempotent: a tile already
// credited for a player is skipped, and every drop is marked processed.
//
// There is no persistent job runner on the site, so this is invoked two ways:
//   1. POST /api/dink/process  (cron / proxy webhook, shared-secret guarded)
//   2. opportunistically at the top of the bingo board load (poll-on-read backstop)

import { db } from '$lib/server/db';

interface DropRow {
	id: number;
	event_id: string | null;
	rsn: string;
	item_id: number | null;
	item_name: string | null;
	quantity: number;
}

interface TrackedRow {
	event_id: string;
	tile_id: string;
	item_id: number | null;
	item_name: string;
}

const BATCH = 500;

// Resolve an RSN to a site user id (case-insensitive, mirrors clan.ts/users.ts).
async function resolveUserId(rsn: string): Promise<string | null> {
	const { data } = await db().from('vs_users').select('id').ilike('rsn', rsn).limit(1).maybeSingle();
	return (data as { id: string } | null)?.id ?? null;
}

// Find the tracked item for a drop within its event (id match preferred, name fallback).
function matchTile(drop: DropRow, tracked: TrackedRow[]): string | null {
	const name = (drop.item_name ?? '').toLowerCase();
	const byId = drop.item_id != null ? tracked.find((t) => t.item_id === drop.item_id) : undefined;
	if (byId) return byId.tile_id;
	const byName = name ? tracked.find((t) => t.item_name.toLowerCase() === name) : undefined;
	return byName?.tile_id ?? null;
}

export async function processDinkDrops(): Promise<{ processed: number; credited: number; error?: string }> {
	const sb = db();

	const { data: drops, error } = await sb
		.from('vs_dink_drops')
		.select('id, event_id, rsn, item_id, item_name, quantity')
		.eq('processed', false)
		.order('received_at', { ascending: true })
		.limit(BATCH);

	if (error) {
		// Table may not exist yet (manual migration) — treat as a no-op.
		return { processed: 0, credited: 0, error: error.message };
	}
	const rows = (drops ?? []) as DropRow[];
	if (rows.length === 0) return { processed: 0, credited: 0 };

	// Load the tracked-item sets for the events present in this batch, once.
	const eventIds = [...new Set(rows.map((r) => r.event_id).filter((e): e is string => !!e))];
	const trackedByEvent = new Map<string, TrackedRow[]>();
	if (eventIds.length) {
		const { data: tracked } = await sb
			.from('vs_event_tracked_items')
			.select('event_id, tile_id, item_id, item_name')
			.in('event_id', eventIds);
		for (const t of (tracked ?? []) as TrackedRow[]) {
			const arr = trackedByEvent.get(t.event_id) ?? [];
			arr.push(t);
			trackedByEvent.set(t.event_id, arr);
		}
	}

	const userIdByRsn = new Map<string, string | null>();
	const processedIds: number[] = [];
	let credited = 0;

	for (const drop of rows) {
		processedIds.push(drop.id);
		if (!drop.event_id) continue;
		const tracked = trackedByEvent.get(drop.event_id);
		if (!tracked || tracked.length === 0) continue;

		const tileId = matchTile(drop, tracked);
		if (!tileId) continue;

		const rsnKey = drop.rsn.toLowerCase();
		if (!userIdByRsn.has(rsnKey)) userIdByRsn.set(rsnKey, await resolveUserId(drop.rsn));
		const userId = userIdByRsn.get(rsnKey) ?? null;
		if (!userId) continue; // dropper isn't a site user → can't attribute; drop still marked processed

		// Idempotent: skip if this player already has an approved completion for the tile.
		const { data: existing } = await sb
			.from('vs_bingo_completions')
			.select('id')
			.eq('event_id', drop.event_id)
			.eq('user_id', userId)
			.eq('tile_id', tileId)
			.eq('status', 'approved')
			.limit(1);
		if (existing && existing.length > 0) continue;

		const now = new Date().toISOString();
		const { error: insErr } = await sb.from('vs_bingo_completions').insert({
			event_id: drop.event_id,
			user_id: userId,
			tile_id: tileId,
			proof_urls: [],
			proof_paths: [],
			status: 'approved',
			submitted_at: now,
			reviewed_at: now,
			reviewed_by: null,
			review_note: `Auto-tracked via Dink (${drop.item_name ?? drop.item_id ?? 'item'})`
		});
		if (!insErr) credited += 1;
	}

	if (processedIds.length) {
		await sb.from('vs_dink_drops').update({ processed: true }).in('id', processedIds);
	}

	return { processed: processedIds.length, credited };
}

// Throttled backstop for the poll-on-read path (bingo board load): runs at most
// once per window per server instance, de-dupes concurrent calls, and never throws
// so a tracking hiccup can't break page rendering.
const THROTTLE_MS = 20_000;
let lastRun = 0;
let inflight: Promise<unknown> | null = null;

export function maybeProcessDinkDrops(): void {
	if (inflight || Date.now() - lastRun < THROTTLE_MS) return;
	lastRun = Date.now();
	inflight = processDinkDrops()
		.catch((e) => console.warn('[dinkDrops] background process failed:', e instanceof Error ? e.message : e))
		.finally(() => {
			inflight = null;
		});
}
