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
import { creditPersonalTile, loadPersonalBoard } from '$lib/server/personalBoard';

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

// A row of the unified per-player active-tiles view (vs_active_player_tiles), filtered to
// `type='item'` — i.e. the tiles this player can currently auto-complete via a Dink drop,
// across all open events AND their personal board. The Dink consumer matches a drop
// against these per user, instead of per-event tracked items.
interface ActiveItemTile {
	user_id: string;
	kind: 'event' | 'personal';
	event_id: string | null;
	tile_id: string | null; // event tile id
	board_id: string | null; // personal board id
	board_idx: number | null; // personal board tile index
	item_id: number | null;
	item_name: string | null;
	match_type: string;
	required_qty: number;
	activated_at: string | null; // a drop only credits if received_at >= this
}

const BATCH = 500;

// Recent-drops re-evaluation window. On a reconcile pass, drops that didn't credit
// because the tile wasn't matchable yet (late signup, board generated after the drop,
// proxy recorded with no event) are resurfaced and re-checked against the CURRENT live
// view. Bounded so a reconcile can never churn the whole ~30-day log. The activation
// rule (received_at >= activated_at) still guards every credit, so a drop obtained
// before its tile was active can never credit on a re-check — only genuine ordering
// races heal.
const RECONCILE_WINDOW_MS = 3 * 24 * 60 * 60 * 1000; // 3 days

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

// Dry-run for a PERSONAL collection-log board: would this COLLECTION drop credit a tile
// on the player's board? Mirrors DropVerdict so the admin simulator renders it uniformly.
// (tileOpenAtDropTime carries the activation check: drop received_at >= board.created_at.)
export async function evaluatePersonalDink(input: {
	rsn: string;
	item_id: number | null;
	item_name: string | null;
	received_at: string;
}): Promise<DropVerdict> {
	const reasons: string[] = [];
	const userId = await resolveUserId(input.rsn);
	if (!userId) {
		reasons.push(`RSN "${input.rsn}" doesn't resolve to a site user (vs_users).`);
		return { wouldCredit: false, reasons, tileId: null, userResolved: false, tileOpenAtDropTime: null, alreadyCredited: false };
	}
	const board = await loadPersonalBoard(userId);
	if (!board) {
		reasons.push('This player has no personal board — generate one at /clog-bingo first.');
		return { wouldCredit: false, reasons, tileId: null, userResolved: true, tileOpenAtDropTime: null, alreadyCredited: false };
	}
	const name = (input.item_name ?? '').toLowerCase();
	const tile = board.tiles.find(
		(t) => (input.item_id != null && t.item_id === input.item_id) || (!!name && t.item_name.toLowerCase() === name)
	);
	if (!tile) {
		reasons.push("No tile on this player's board matches that item id/name.");
		return { wouldCredit: false, reasons, tileId: null, userResolved: true, tileOpenAtDropTime: null, alreadyCredited: false };
	}
	const tileId = `p:${board.id}:${tile.idx}`;
	const already = tile.obtained;
	if (already) reasons.push(`Board tile "${tile.item_name}" is already obtained.`);
	// Activation rule: the drop must be received at/after the board was created.
	const active = new Date(input.received_at).getTime() >= new Date(board.created_at).getTime();
	if (!active) reasons.push(`Drop received before the board was created (${board.created_at}) — activation rule rejects it.`);
	const wouldCredit = !already && active;
	if (wouldCredit) reasons.unshift(`✓ Would credit board tile "${tile.item_name}".`);
	return { wouldCredit, reasons, tileId, userResolved: true, tileOpenAtDropTime: active, alreadyCredited: already };
}

// Full-pipeline test: insert a synthetic vs_dink_drops row exactly as the proxy
// would, then run the real consumer. Returns the consumer result. (Use against a
// PREVIEW event so it isn't publicly visible, or event_id=null for a personal board.)
export async function simulateDinkDrop(input: {
	event_id: string | null;
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

// Parse the attributed-tile marker the consumer stamps on a credited drop. Personal-board
// credits are stamped `p:<board_id>:<board_idx>`; event credits store the bare tile_id.
function parsePersonalTileMarker(tileId: string | null): { boardId: string; idx: number } | null {
	if (!tileId || !tileId.startsWith('p:')) return null;
	const rest = tileId.slice(2);
	const sep = rest.lastIndexOf(':');
	if (sep < 0) return null;
	const boardId = rest.slice(0, sep);
	const idx = Number(rest.slice(sep + 1));
	if (!boardId || !Number.isFinite(idx)) return null;
	return { boardId, idx };
}

// Admin: reverse a wrong auto-credit. Reads the tile the consumer attributed the drop to
// (stamped on the drop) and undoes that credit — deletes the event completion OR un-flips
// the personal-board tile — then marks the drop 'reverted' (so the consumer won't re-credit
// it; it stays processed). Idempotent.
export async function revertDinkCredit(dropId: number): Promise<{ ok: boolean; error?: string }> {
	const sb = db();
	const { data: d } = await sb
		.from('vs_dink_drops')
		.select('id, event_id, rsn, item_id, item_name, notif_type, tile_id')
		.eq('id', dropId)
		.maybeSingle();
	const row = d as
		| (Pick<DropRow, 'id' | 'event_id' | 'rsn' | 'item_id' | 'item_name' | 'notif_type'> & { tile_id: string | null })
		| null;
	if (!row) return { ok: false, error: 'Drop not found' };

	// Personal-board credit: un-flip the tile (obtained → false). No event/user delete.
	const personal = parsePersonalTileMarker(row.tile_id);
	if (personal) {
		const { error: upErr } = await sb
			.from('vs_personal_board_tiles')
			.update({ obtained: false, obtained_at: null })
			.eq('board_id', personal.boardId)
			.eq('idx', personal.idx);
		if (upErr) return { ok: false, error: upErr.message };
		await sb.from('vs_dink_drops').update({ outcome: 'reverted' }).eq('id', dropId);
		return { ok: true };
	}

	// Event credit: derive the user + tile, then delete the auto-tracked approved completion.
	if (!row.event_id) return { ok: false, error: 'Drop has no event' };
	const userId = await resolveUserId(row.rsn);
	if (!userId) return { ok: false, error: 'RSN does not resolve to a site user' };

	// Prefer the tile the consumer attributed; fall back to re-matching legacy drops that
	// predate tile stamping.
	let tileId = row.tile_id;
	if (!tileId) {
		const { data: trackedRaw } = await sb
			.from('vs_event_tracked_items')
			.select('event_id, tile_id, item_id, item_name, match_type, required_qty')
			.eq('event_id', row.event_id);
		const matched = matchTracked(
			{ id: 0, event_id: row.event_id, rsn: row.rsn, item_id: row.item_id, item_name: row.item_name, quantity: 1, received_at: '', notif_type: row.notif_type },
			(trackedRaw ?? []) as TrackedRow[]
		);
		if (!matched) return { ok: false, error: 'No matching tile for this drop' };
		tileId = matched.tile_id;
	}

	const { error: delErr } = await sb
		.from('vs_bingo_completions')
		.delete()
		.eq('event_id', row.event_id)
		.eq('user_id', userId)
		.eq('tile_id', tileId)
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
		.eq('tile_id', tileId)
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
	opts: { suppressFeed?: boolean; reconcile?: boolean } = {}
): Promise<{ processed: number; credited: number; error?: string }> {
	const sb = db();

	// Reconcile pass: resurface recent un-credited drops whose situation may have changed
	// (the player linked an account, signed up, or generated a board AFTER the drop). They
	// re-run through the same matching + activation gate below. Only outcomes that can flip
	// on a re-check are resurfaced — a 'timing' drop (received before activation) never can.
	if (opts.reconcile) {
		const since = new Date(Date.now() - RECONCILE_WINDOW_MS).toISOString();
		await sb
			.from('vs_dink_drops')
			.update({ processed: false, outcome: null })
			.in('outcome', ['no_tile', 'no_user'])
			.gte('received_at', since);
	}

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

	// Per-batch caches.
	const userIdByRsn = new Map<string, string | null>();
	const objectivesByUser = new Map<string, ActiveItemTile[]>();
	type EventCtx = { start: string | null; status: string; slug: string; name: string; board: Awaited<ReturnType<typeof loadEventBoard>> };
	const eventCache = new Map<string, EventCtx | null>();

	// Per drop: the verdict + the tile/event it was attributed to (persisted so collect-N
	// partials stay tile-scoped and an admin revert can find them).
	const outcomeById = new Map<number, Outcome>();
	const tileIdByDrop = new Map<number, string>();
	const eventIdByDrop = new Map<number, string>();
	const feedPosts: { by: string; tileName: string; eventName: string; eventSlug: string; via: string | null }[] = [];
	let credited = 0;

	// The player's currently-active ITEM tiles (open-event tiles + their personal board),
	// from the live view. The drop is matched against THIS user's tiles only — so credit
	// is per-user-correct (a drop only ever completes the dropper's own tiles). Cached.
	async function objectivesFor(userId: string): Promise<ActiveItemTile[]> {
		const hit = objectivesByUser.get(userId);
		if (hit) return hit;
		const { data, error: vErr } = await sb
			.from('vs_active_player_tiles')
			.select('user_id, kind, event_id, tile_id, board_id, board_idx, item_id, item_name, match_type, required_qty, activated_at')
			.eq('user_id', userId)
			.eq('type', 'item');
		if (vErr) console.error('[dink] active-tiles read failed for', userId, vErr.message);
		const list = (data ?? []) as ActiveItemTile[];
		objectivesByUser.set(userId, list);
		return list;
	}

	async function eventCtxFor(eventId: string): Promise<EventCtx | null> {
		if (eventCache.has(eventId)) return eventCache.get(eventId) ?? null;
		const { data: e } = await sb
			.from('vs_events')
			.select('id, slug, name, status, structure, starts_at, signup_opens_at')
			.eq('id', eventId)
			.maybeSingle();
		if (!e) { eventCache.set(eventId, null); return null; }
		const ev = e as { id: string; slug: string; name: string; status: string; structure: unknown; starts_at: string | null; signup_opens_at: string | null };
		const ctx: EventCtx = { start: ev.starts_at ?? ev.signup_opens_at, status: ev.status, slug: ev.slug, name: ev.name, board: await loadEventBoard(ev) };
		eventCache.set(eventId, ctx);
		return ctx;
	}

	type CandResult = Outcome | 'retry'; // 'retry' = transient error → leave drop unprocessed

	// Credit one PERSONAL board tile: activation rule, then flip obtained (shared helper).
	async function creditPersonal(drop: DropRow, cand: ActiveItemTile): Promise<CandResult> {
		// A drop obtained BEFORE the board (tile) became active never credits it.
		if (cand.activated_at && new Date(drop.received_at).getTime() < new Date(cand.activated_at).getTime())
			return 'timing';
		const res = await creditPersonalTile(cand.board_id as string, cand.board_idx as number);
		if (res === 'error') return 'retry';
		return res === 'credited' ? 'credited' : 'duplicate';
	}

	// Credit one EVENT tile: timing gate (= activation), idempotency, collect-N, then the
	// approved-completion insert (unchanged hardening). Queues a feed post on success.
	async function creditEvent(drop: DropRow, cand: ActiveItemTile, userId: string): Promise<CandResult> {
		const eventId = cand.event_id as string;
		const tileId = cand.tile_id as string;
		const ctx = await eventCtxFor(eventId);
		if (!ctx) return 'no_tile';
		const tile = ctx.board.tiles.find((t) => t.id === tileId);
		if (!tile) return 'no_tile';
		// Activation/timing: the tile must have been OPEN at the drop's received_at.
		const stateAtDrop = getBingoState(ctx.start, new Date(drop.received_at), ctx.board.structure);
		if (getTileStatus(tile, stateAtDrop) !== 'open') return 'timing';

		// Idempotency (the view already excludes completed tiles; this guards a race).
		const { data: existing, error: existErr } = await sb
			.from('vs_bingo_completions')
			.select('id').eq('event_id', eventId).eq('user_id', userId).eq('tile_id', tileId).eq('status', 'approved').limit(1);
		if (existErr) { console.error('[dink] dup-check failed for drop', drop.id, existErr.message); return 'retry'; }
		if (existing && existing.length > 0) return 'duplicate';

		// Collect-N: accumulate prior partials scoped to THIS event+tile for this player.
		const need = Math.max(1, cand.required_qty || 1);
		const partialIds: number[] = [];
		if (need > 1) {
			const { data: priorPartials, error: ppErr } = await sb
				.from('vs_dink_drops')
				.select('id, quantity')
				.eq('event_id', eventId).eq('tile_id', tileId).ilike('rsn', rsnExactPattern(drop.rsn)).eq('outcome', 'partial');
			if (ppErr) console.error('[dink] partial-sum read failed for drop', drop.id, ppErr.message);
			let priorQty = 0;
			for (const p of (priorPartials ?? []) as { id: number; quantity: number }[]) { priorQty += Number(p.quantity) || 0; partialIds.push(p.id); }
			if (priorQty + (Number(drop.quantity) || 1) < need) return 'partial';
		}

		const now = new Date().toISOString();
		const { error: insErr } = await sb.from('vs_bingo_completions').insert({
			event_id: eventId, user_id: userId, tile_id: tileId,
			// Mirror the manual submit path's column set (legacy proof_url/proof_path may be NOT NULL).
			proof_url: '', proof_path: '', proof_urls: [], proof_paths: [],
			status: 'approved', source: 'dink', submitted_at: now, reviewed_at: now, reviewed_by: null,
			review_note: `Auto-tracked via Dink (${drop.item_name ?? drop.item_id ?? 'item'})`
		});
		if (insErr) {
			if (insErr.code === '23505') return 'duplicate'; // unique approved index → already credited
			console.error('[dink] completion insert failed for drop', drop.id, insErr.message);
			return 'retry';
		}
		// Roll the consumed partials in so a later drop can't re-credit after a revert.
		if (partialIds.length) await sb.from('vs_dink_drops').update({ outcome: 'consumed', processed: true }).in('id', partialIds);
		// Queue the Discord announcement (open, non-self-test, not suppressed).
		if (!opts.suppressFeed && ctx.status === 'open' && !FEED_SUPPRESS_SLUGS.has(ctx.slug)) {
			feedPosts.push({ by: drop.rsn, tileName: tile.name || tileId, eventName: ctx.name, eventSlug: ctx.slug, via: drop.item_name ?? (drop.item_id != null ? `#${drop.item_id}` : null) });
		}
		return 'credited';
	}

	// Priority when one drop touches several candidates (e.g. an event tile + a board tile).
	const RANK: Record<string, number> = { credited: 5, partial: 4, duplicate: 3, timing: 2, no_user: 1, no_tile: 0, consumed: 0, reverted: 0 };

	for (const drop of rows) {
		const rsnKey = drop.rsn.toLowerCase();
		if (!userIdByRsn.has(rsnKey)) userIdByRsn.set(rsnKey, await resolveUserId(drop.rsn));
		const userId = userIdByRsn.get(rsnKey) ?? null;
		if (!userId) { outcomeById.set(drop.id, 'no_user'); continue; }

		const notif = drop.notif_type || 'loot';
		const dname = (drop.item_name ?? '').toLowerCase();
		const candidates = (await objectivesFor(userId)).filter((o) => {
			if ((o.match_type || 'loot') !== notif) return false;
			if (o.item_id != null && drop.item_id != null) return o.item_id === drop.item_id;
			return !!dname && (o.item_name ?? '').toLowerCase() === dname;
		});
		if (candidates.length === 0) { outcomeById.set(drop.id, 'no_tile'); continue; }

		// Credit every matching candidate (a drop may complete an event tile AND a board
		// tile). Track the best outcome; if any candidate hit a transient error, leave the
		// whole drop unprocessed so it retries (re-credit is idempotent).
		let best: Outcome = 'no_tile';
		let bestTile: string | null = null;
		let bestEvent: string | null = null;
		let retry = false;
		for (const cand of candidates) {
			const res = cand.kind === 'personal' ? await creditPersonal(drop, cand) : await creditEvent(drop, cand, userId);
			if (res === 'retry') { retry = true; continue; }
			if (res === 'credited') credited += 1;
			if ((RANK[res] ?? 0) >= (RANK[best] ?? 0)) {
				best = res;
				bestTile = cand.kind === 'personal' ? `p:${cand.board_id}:${cand.board_idx}` : cand.tile_id;
				bestEvent = cand.event_id;
			}
		}
		if (retry) continue; // not added to outcomeById → stays unprocessed → retried
		outcomeById.set(drop.id, best);
		if (bestTile) tileIdByDrop.set(drop.id, bestTile);
		if (bestEvent) eventIdByDrop.set(drop.id, bestEvent);
	}

	// Mark processed + stamp verdict + the attributed event/tile (so collect-N partials are
	// tile-scoped and revert can locate them), grouped to minimise requests.
	const idsByKey = new Map<string, { outcome: Outcome; tileId: string | null; eventId: string | null; ids: number[] }>();
	for (const [id, outcome] of outcomeById) {
		const tileId = tileIdByDrop.get(id) ?? null;
		const eventId = eventIdByDrop.get(id) ?? null;
		const key = `${outcome}|${eventId ?? ''}|${tileId ?? ''}`;
		const group = idsByKey.get(key) ?? { outcome, tileId, eventId, ids: [] };
		group.ids.push(id);
		idsByKey.set(key, group);
	}
	for (const { outcome, tileId, eventId, ids } of idsByKey.values()) {
		const patch: Record<string, unknown> = { processed: true, outcome, tile_id: tileId };
		if (eventId) patch.event_id = eventId;
		await sb.from('vs_dink_drops').update(patch).in('id', ids);
	}

	if (feedPosts.length) await Promise.allSettled(feedPosts.map((p) => postBingoCredit({ ...p, rsn: p.by })));

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
