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
import { rsnExactPattern } from '$lib/server/users';
import { loadEventBoard } from '$lib/server/eventStructure';
import { getBingoState, getTileStatus } from '$lib/bingo/state';
import { postBingoCredit } from '$lib/server/dropsFeed';

// The self-test event shouldn't spam the public bingo feed when members test Dink.
const FEED_SUPPRESS_SLUGS = new Set(['dink-self-test']);

interface DropRow {
	id: number;
	event_id: string | null;
	rsn: string;
	item_id: number | null;
	item_name: string | null;
	quantity: number;
	received_at: string;
	notif_type: string;
}

interface TrackedRow {
	event_id: string;
	tile_id: string;
	item_id: number | null;
	item_name: string;
	match_type: string;
	required_qty: number;
}

const BATCH = 500;

// Consumer verdict recorded on each drop (vs_dink_drops.outcome) so admins can see
// why a drop did or didn't credit a tile.
type Outcome =
	| 'credited'
	| 'no_tile'
	| 'no_user'
	| 'timing'
	| 'duplicate'
	| 'partial'
	| 'consumed' // a prior partial that has now been rolled into a completed collect-N tile
	| 'reverted';

// Resolve an RSN to a site user id (case-insensitive, mirrors clan.ts/users.ts).
async function resolveUserId(rsn: string): Promise<string | null> {
	// Escape the RSN so a stray '_'/'%' can't match the wrong row (OSRS treats
	// space/underscore as equal — same exact-match helper the vs_users lookups use).
	const { data } = await db()
		.from('vs_users')
		.select('id')
		.ilike('rsn', rsnExactPattern(rsn))
		.limit(1)
		.maybeSingle();
	return (data as { id: string } | null)?.id ?? null;
}

// Find the tracked item for a drop within its event (id match preferred, name fallback).
// Only considers tracked items whose match_type matches the drop's notif_type, so a
// LOOT drop credits 'loot' tiles and a COLLECTION unlock credits 'collection' tiles.
// Returns the matched tracked row (carries tile_id + required_qty for collect-N).
function matchTracked(drop: DropRow, tracked: TrackedRow[]): TrackedRow | null {
	const notif = drop.notif_type || 'loot';
	const candidates = tracked.filter((t) => (t.match_type || 'loot') === notif);
	const name = (drop.item_name ?? '').toLowerCase();
	const byId = drop.item_id != null ? candidates.find((t) => t.item_id === drop.item_id) : undefined;
	if (byId) return byId;
	const byName = name ? candidates.find((t) => t.item_name.toLowerCase() === name) : undefined;
	return byName ?? null;
}

// ── Admin testing helpers ───────────────────────────────────────────────────

export interface DropVerdict {
	wouldCredit: boolean;
	reasons: string[];
	tileId: string | null;
	userResolved: boolean;
	tileOpenAtDropTime: boolean | null;
	alreadyCredited: boolean;
}

// Dry-run: run the exact match → identity → timing → idempotency logic for a
// hypothetical drop WITHOUT writing anything. Used by the admin drop simulator so
// auto-tracking can be validated against any event (even draft/preview) safely.
export async function evaluateDinkDrop(input: {
	event_id: string;
	rsn: string;
	item_id: number | null;
	item_name: string | null;
	source: string | null;
	received_at: string;
	notif_type?: string;
}): Promise<DropVerdict> {
	const sb = db();
	const reasons: string[] = [];

	const { data: ev } = await sb
		.from('vs_events')
		.select('id, slug, structure, starts_at, signup_opens_at, status')
		.eq('id', input.event_id)
		.maybeSingle();
	if (!ev) return { wouldCredit: false, reasons: ['Event not found'], tileId: null, userResolved: false, tileOpenAtDropTime: null, alreadyCredited: false };

	const { data: trackedRaw } = await sb
		.from('vs_event_tracked_items')
		.select('event_id, tile_id, item_id, item_name, match_type, required_qty')
		.eq('event_id', input.event_id);
	const tracked = (trackedRaw ?? []) as TrackedRow[];

	const drop: DropRow = {
		id: 0,
		event_id: input.event_id,
		rsn: input.rsn,
		item_id: input.item_id,
		item_name: input.item_name,
		quantity: 1,
		received_at: input.received_at,
		notif_type: input.notif_type || 'loot'
	};
	const matched = matchTracked(drop, tracked);
	const tileId = matched?.tile_id ?? null;
	if (!tileId) reasons.push('No tracked item matches this item id/name for the event.');

	const userId = await resolveUserId(input.rsn);
	if (!userId) reasons.push(`RSN "${input.rsn}" doesn't resolve to a site user (vs_users).`);

	let tileOpen: boolean | null = null;
	let already = false;
	if (tileId) {
		const board = await loadEventBoard(ev);
		const tile = board.tiles.find((t) => t.id === tileId);
		if (!tile) {
			reasons.push(`Tile ${tileId} not found on the event board.`);
		} else {
			const state = getBingoState(ev.starts_at ?? ev.signup_opens_at, new Date(input.received_at), board.structure);
			tileOpen = getTileStatus(tile, state) === 'open';
			if (!tileOpen) reasons.push(`Tile ${tileId} was not open at the drop time (event not started / row not released).`);
		}
		if (userId) {
			const { data: ex } = await sb
				.from('vs_bingo_completions')
				.select('id')
				.eq('event_id', input.event_id)
				.eq('user_id', userId)
				.eq('tile_id', tileId)
				.eq('status', 'approved')
				.limit(1);
			already = !!(ex && ex.length);
			if (already) reasons.push('This player already has an approved completion for the tile.');
		}
	}

	const wouldCredit = !!tileId && !!userId && tileOpen === true && !already;
	if (wouldCredit) reasons.unshift(`✓ Would credit tile ${tileId}.`);
	return { wouldCredit, reasons, tileId, userResolved: !!userId, tileOpenAtDropTime: tileOpen, alreadyCredited: already };
}

// Full-pipeline test: insert a synthetic vs_dink_drops row exactly as the proxy
// would, then run the real consumer. Returns the consumer result. (Use against a
// PREVIEW event so it isn't publicly visible.)
export async function simulateDinkDrop(input: {
	event_id: string;
	rsn: string;
	item_id: number | null;
	item_name: string | null;
	source: string | null;
	received_at: string;
	notif_type?: string;
}): Promise<{ ok: boolean; error?: string; processed: number; credited: number }> {
	const sb = db();
	// Random suffix (not just Date.now()) so two simulations in the same millisecond
	// can't collide on the drop_key unique constraint.
	const dropKey = `test-${input.event_id}-${input.item_id ?? input.item_name}-${input.rsn}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
	const { error } = await sb.from('vs_dink_drops').insert({
		event_id: input.event_id,
		rsn: input.rsn,
		item_id: input.item_id,
		item_name: input.item_name,
		quantity: 1,
		source: input.source,
		dink_ts: input.received_at,
		received_at: input.received_at,
		drop_key: dropKey,
		notif_type: input.notif_type || 'loot',
		processed: false
	});
	if (error) return { ok: false, error: error.message, processed: 0, credited: 0 };
	// Suppress the public feed: an admin simulating a drop must never post a real
	// bingo-credit announcement, even against an open event.
	const res = await processDinkDrops({ suppressFeed: true });
	return { ok: !res.error, error: res.error, processed: res.processed, credited: res.credited };
}

// Admin: reverse a wrong auto-credit. Re-derives the user + tile from the drop and
// deletes the auto-tracked approved completion, then marks the drop 'reverted' (so the
// consumer won't re-credit it — it stays processed). Idempotent.
export async function revertDinkCredit(dropId: number): Promise<{ ok: boolean; error?: string }> {
	const sb = db();
	const { data: d } = await sb
		.from('vs_dink_drops')
		.select('id, event_id, rsn, item_id, item_name, notif_type')
		.eq('id', dropId)
		.maybeSingle();
	const row = d as Pick<DropRow, 'id' | 'event_id' | 'rsn' | 'item_id' | 'item_name' | 'notif_type'> | null;
	if (!row) return { ok: false, error: 'Drop not found' };
	if (!row.event_id) return { ok: false, error: 'Drop has no event' };
	const userId = await resolveUserId(row.rsn);
	if (!userId) return { ok: false, error: 'RSN does not resolve to a site user' };

	const { data: trackedRaw } = await sb
		.from('vs_event_tracked_items')
		.select('event_id, tile_id, item_id, item_name, match_type, required_qty')
		.eq('event_id', row.event_id);
	const matched = matchTracked(
		{ id: 0, event_id: row.event_id, rsn: row.rsn, item_id: row.item_id, item_name: row.item_name, quantity: 1, received_at: '', notif_type: row.notif_type },
		(trackedRaw ?? []) as TrackedRow[]
	);
	if (!matched) return { ok: false, error: 'No matching tile for this drop' };

	const { error: delErr } = await sb
		.from('vs_bingo_completions')
		.delete()
		.eq('event_id', row.event_id)
		.eq('user_id', userId)
		.eq('tile_id', matched.tile_id)
		.eq('status', 'approved')
		.eq('source', 'dink'); // a real column, not a review_note text prefix
	if (delErr) return { ok: false, error: delErr.message };
	await sb.from('vs_dink_drops').update({ outcome: 'reverted' }).eq('id', dropId);
	// Restore any partial drops that were rolled into this completion, so the player's
	// collect-N progress isn't lost and a single new drop can't instantly re-credit.
	await sb
		.from('vs_dink_drops')
		.update({ outcome: 'partial' })
		.eq('event_id', row.event_id)
		.eq('tile_id', matched.tile_id)
		.ilike('rsn', rsnExactPattern(row.rsn))
		.eq('outcome', 'consumed');
	return { ok: true };
}

// Admin: re-run a single drop through the consumer (e.g. after adding the tile or
// fixing the player's RSN). Clears its processed/outcome then drains the queue.
export async function reprocessDinkDrop(dropId: number): Promise<{ processed: number; credited: number; error?: string }> {
	await db().from('vs_dink_drops').update({ processed: false, outcome: null }).eq('id', dropId);
	return processDinkDrops();
}

export async function processDinkDrops(
	opts: { suppressFeed?: boolean } = {}
): Promise<{ processed: number; credited: number; error?: string }> {
	const sb = db();

	const { data: drops, error } = await sb
		.from('vs_dink_drops')
		.select('id, event_id, rsn, item_id, item_name, quantity, received_at, notif_type')
		.eq('processed', false)
		.order('received_at', { ascending: true })
		.limit(BATCH);

	if (error) {
		// Table may not exist yet (manual migration) — treat as a no-op.
		return { processed: 0, credited: 0, error: error.message };
	}
	const rows = (drops ?? []) as DropRow[];
	if (rows.length === 0) return { processed: 0, credited: 0 };

	// Load, once per event in this batch: the tracked-item set, the event row (for
	// timing), and the board (tiles + structure for row-release timing).
	const eventIds = [...new Set(rows.map((r) => r.event_id).filter((e): e is string => !!e))];
	const trackedByEvent = new Map<string, TrackedRow[]>();
	const eventById = new Map<string, { id: string; slug: string; name: string; status: string; structure: unknown; start: string | null }>();
	const boardByEvent = new Map<string, Awaited<ReturnType<typeof loadEventBoard>>>();
	if (eventIds.length) {
		const { data: tracked } = await sb
			.from('vs_event_tracked_items')
			.select('event_id, tile_id, item_id, item_name, match_type, required_qty')
			.in('event_id', eventIds);
		for (const t of (tracked ?? []) as TrackedRow[]) {
			const arr = trackedByEvent.get(t.event_id) ?? [];
			arr.push(t);
			trackedByEvent.set(t.event_id, arr);
		}

		const { data: events } = await sb
			.from('vs_events')
			.select('id, slug, name, status, structure, starts_at, signup_opens_at')
			.in('id', eventIds);
		for (const e of (events ?? []) as Array<{
			id: string; slug: string; name: string; status: string; structure: unknown; starts_at: string | null; signup_opens_at: string | null;
		}>) {
			eventById.set(e.id, { id: e.id, slug: e.slug, name: e.name, status: e.status, structure: e.structure, start: e.starts_at ?? e.signup_opens_at });
			boardByEvent.set(e.id, await loadEventBoard(e));
		}
	}

	const userIdByRsn = new Map<string, string | null>();
	// Record a verdict per drop so the admin "why no credit?" view can explain it.
	const outcomeById = new Map<number, Outcome>();
	// The tile each drop was attributed to (persisted alongside the outcome) so a
	// partial drop is scoped to its tile and a credit can mark its own partials consumed.
	const tileIdByDrop = new Map<number, string>();
	const feedPosts: { by: string; tileName: string; eventName: string; eventSlug: string; via: string | null }[] = [];
	let credited = 0;

	for (const drop of rows) {
		if (!drop.event_id) {
			outcomeById.set(drop.id, 'no_tile');
			continue;
		}
		const tracked = trackedByEvent.get(drop.event_id);
		if (!tracked || tracked.length === 0) {
			outcomeById.set(drop.id, 'no_tile');
			continue;
		}

		const matched = matchTracked(drop, tracked);
		if (!matched) {
			outcomeById.set(drop.id, 'no_tile');
			continue;
		}
		const tileId = matched.tile_id;

		// Timing gate: only credit if the tile was actually OPEN when the drop happened
		// (received_at) — i.e. the event had started and that tile's row had released.
		// Drops obtained before a row unlocks (or before the event) are discarded, the
		// same rule a manual board submission is held to.
		const ev = eventById.get(drop.event_id);
		const board = boardByEvent.get(drop.event_id);
		if (!ev || !board) {
			outcomeById.set(drop.id, 'no_tile');
			continue;
		}
		const tile = board.tiles.find((t) => t.id === tileId);
		if (!tile) {
			outcomeById.set(drop.id, 'no_tile');
			continue;
		}
		const stateAtDrop = getBingoState(ev.start, new Date(drop.received_at), board.structure);
		if (getTileStatus(tile, stateAtDrop) !== 'open') {
			outcomeById.set(drop.id, 'timing'); // tile wasn't active at drop time
			continue;
		}

		const rsnKey = drop.rsn.toLowerCase();
		if (!userIdByRsn.has(rsnKey)) userIdByRsn.set(rsnKey, await resolveUserId(drop.rsn));
		const userId = userIdByRsn.get(rsnKey) ?? null;
		if (!userId) {
			outcomeById.set(drop.id, 'no_user'); // dropper isn't a site user → can't attribute
			continue;
		}

		// Idempotent: skip if this player already has an approved completion for the tile.
		const { data: existing, error: existErr } = await sb
			.from('vs_bingo_completions')
			.select('id')
			.eq('event_id', drop.event_id)
			.eq('user_id', userId)
			.eq('tile_id', tileId)
			.eq('status', 'approved')
			.limit(1);
		if (existErr) {
			// Don't risk a double-credit on a flaky read — leave the drop unprocessed and
			// log it; the unique index is the real backstop, but skipping is safest here.
			console.error('[dink] dup-check failed for drop', drop.id, existErr.message);
			continue;
		}
		if (existing && existing.length > 0) {
			outcomeById.set(drop.id, 'duplicate');
			tileIdByDrop.set(drop.id, tileId);
			continue;
		}

		// Collect-N: a tile that needs more than one of an item only credits once the
		// player's accumulated quantity reaches required_qty. Prior drops attributed to
		// THIS tile are marked 'partial'; we sum those plus this drop. Scoping by tile_id
		// (not just item) keeps two collect-N tiles tracking the same item from pooling.
		const need = Math.max(1, matched.required_qty || 1);
		const partialIds: number[] = [];
		if (need > 1) {
			const { data: priorPartials, error: ppErr } = await sb
				.from('vs_dink_drops')
				.select('id, quantity')
				.eq('event_id', drop.event_id)
				.eq('tile_id', tileId)
				.ilike('rsn', rsnExactPattern(drop.rsn))
				.eq('outcome', 'partial');
			if (ppErr) console.error('[dink] partial-sum read failed for drop', drop.id, ppErr.message);
			let priorQty = 0;
			for (const p of (priorPartials ?? []) as { id: number; quantity: number }[]) {
				priorQty += Number(p.quantity) || 0;
				partialIds.push(p.id);
			}
			const total = priorQty + (Number(drop.quantity) || 1);
			if (total < need) {
				outcomeById.set(drop.id, 'partial');
				tileIdByDrop.set(drop.id, tileId);
				continue;
			}
		}

		const now = new Date().toISOString();
		const { error: insErr } = await sb.from('vs_bingo_completions').insert({
			event_id: drop.event_id,
			user_id: userId,
			tile_id: tileId,
			// Mirror the manual submit path's column set — the legacy singular proof_url/
			// proof_path columns may be NOT NULL, which would otherwise fail every insert.
			proof_url: '',
			proof_path: '',
			proof_urls: [],
			proof_paths: [],
			status: 'approved',
			source: 'dink',
			submitted_at: now,
			reviewed_at: now,
			reviewed_by: null,
			review_note: `Auto-tracked via Dink (${drop.item_name ?? drop.item_id ?? 'item'})`
		});
		if (insErr) {
			// Unique index (event,user,tile) WHERE approved → a concurrent/other-instance
			// credit already landed. Treat as duplicate (done), not a transient failure.
			if (insErr.code === '23505') {
				outcomeById.set(drop.id, 'duplicate');
				tileIdByDrop.set(drop.id, tileId);
				continue;
			}
			// Otherwise leave unprocessed so a genuinely transient failure retries — but
			// LOG it, so a systemic failure (e.g. a NOT NULL column) is visible instead of
			// silently looping forever.
			console.error('[dink] completion insert failed for drop', drop.id, insErr.message);
			continue;
		}
		outcomeById.set(drop.id, 'credited');
		tileIdByDrop.set(drop.id, tileId);
		// Roll the prior partials into this completion so they can't be re-summed (which
		// would let a single later drop re-credit the tile after a revert).
		if (partialIds.length) {
			await sb.from('vs_dink_drops').update({ outcome: 'consumed', processed: true }).in('id', partialIds);
		}
		credited += 1;

		// Queue a Discord announcement (public, open events only; never the self-test,
		// and never when the caller suppresses the feed — e.g. the admin simulator).
		if (!opts.suppressFeed && ev.status === 'open' && !FEED_SUPPRESS_SLUGS.has(ev.slug)) {
			feedPosts.push({
				by: drop.rsn,
				tileName: tile.name || tileId,
				eventName: ev.name,
				eventSlug: ev.slug,
				via: drop.item_name ?? (drop.item_id != null ? `#${drop.item_id}` : null)
			});
		}
	}

	// Mark processed + stamp the verdict (and the attributed tile_id, so partials are
	// tile-scoped), grouped by outcome+tile to minimise requests.
	const idsByKey = new Map<string, { outcome: Outcome; tileId: string | null; ids: number[] }>();
	for (const [id, outcome] of outcomeById) {
		const tileId = tileIdByDrop.get(id) ?? null;
		const key = `${outcome}|${tileId ?? ''}`;
		const group = idsByKey.get(key) ?? { outcome, tileId, ids: [] };
		group.ids.push(id);
		idsByKey.set(key, group);
	}
	for (const { outcome, tileId, ids } of idsByKey.values()) {
		await sb.from('vs_dink_drops').update({ processed: true, outcome, tile_id: tileId }).in('id', ids);
	}

	// Announce credited tiles (best-effort; never blocks or throws the consumer).
	if (feedPosts.length) {
		await Promise.allSettled(feedPosts.map((p) => postBingoCredit({ ...p, rsn: p.by })));
	}

	return { processed: outcomeById.size, credited };
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
