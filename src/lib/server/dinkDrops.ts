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
import { getTrackedItemsForUser, type ActiveItemTile } from '$lib/server/dinkAllowlist';
import { activeBattleshipFor, earnBomb } from '$lib/server/battleship';
import { claimTile, sideForUser, pieceForDropKey, racedOutOf, anyLiveConnect4, CONNECT4_KIND } from '$lib/server/connect4';

// Slugs whose auto-credits should NOT post to the public bingo feed. The old dink-self-test
// event lived here; it's now a manual pin with no event, so there's nothing to suppress —
// kept as an extension point.
const FEED_SUPPRESS_SLUGS = new Set<string>();

interface DropRow {
	id: number;
	event_id: string | null;
	rsn: string;
	item_id: number | null;
	item_name: string | null;
	quantity: number;
	received_at: string;
	notif_type: string;
	// Battleship scores drops by VALUE, not by item, so the consumer needs the gp figure
	// and the proxy's dedup key (which is what makes minting a bomb idempotent).
	value?: number | null;
	source?: string | null;
	drop_key?: string | null;
	// Dink screenshot for the drop (proxy-uploaded public URL) — becomes the credited
	// submission's proof image so reviewers can eyeball the actual drop.
	image_url?: string | null;
}

interface TrackedRow {
	event_id: string;
	tile_id: string;
	item_id: number | null;
	item_name: string;
	match_type: string;
	required_qty: number;
}

// `ActiveItemTile` (a row of vs_active_player_tiles, type='item') is defined in and imported
// from dinkAllowlist.ts — the single API for a member's tracked-item set.

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
	| 'raced' // lost the race for a shared Connect Four tile — terminal, like duplicate
	| 'partial'
	| 'consumed' // a prior partial that has now been rolled into a completed collect-N tile
	| 'reverted'
	| 'bomb'; // matched no tile, but was big enough to arm a Battleship bomb

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

// Find the tracked item for a drop (id match preferred, name fallback). WATCH BOTH WAYS:
// match regardless of notif_type — a tile is creditable from either a LOOT drop or a
// COLLECTION unlock of the item, so a mis-tagged match_type can never cause a silent miss
// (and an already-owned item, which fires no new clog unlock, still credits on a loot drop).
// Idempotency (unique approved index) makes a loot+collection double-fire safe.
// Returns the matched tracked row (carries tile_id + required_qty for collect-N).
function matchTracked(drop: DropRow, tracked: TrackedRow[]): TrackedRow | null {
	const name = (drop.item_name ?? '').toLowerCase();
	const byId = drop.item_id != null ? tracked.find((t) => t.item_id === drop.item_id) : undefined;
	if (byId) return byId;
	const byName = name ? tracked.find((t) => t.item_name.toLowerCase() === name) : undefined;
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
		reasons.push('This player has no personal board — generate one at /events/personal-bingo first.');
		return { wouldCredit: false, reasons, tileId: null, userResolved: true, tileOpenAtDropTime: null, alreadyCredited: false };
	}
	const name = (input.item_name ?? '').toLowerCase();
	const tile = board.tiles.find(
		(t) =>
			t.kind === 'item' &&
			((input.item_id != null && t.item_id === input.item_id) ||
				(!!name && (t.item_name ?? '').toLowerCase() === name))
	);
	if (!tile) {
		reasons.push("No tile on this player's board matches that item id/name.");
		return { wouldCredit: false, reasons, tileId: null, userResolved: true, tileOpenAtDropTime: null, alreadyCredited: false };
	}
	const tileId = `p:${board.id}:${tile.idx}`;
	const already = tile.obtained;
	if (already) reasons.push(`Board tile "${tile.item_name}" is already obtained.`);
	// Activation rule: only LOCKED boards are tracked; the drop must be at/after lock time.
	const active = board.locked_at != null && new Date(input.received_at).getTime() >= new Date(board.locked_at).getTime();
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

	// Personal-board credit: delete the auto (dink) ledger credit → the tile reopens (obtained is
	// derived from the ledger). No event/user delete.
	const personal = parsePersonalTileMarker(row.tile_id);
	if (personal) {
		const { error: delErr } = await sb
			.from('vs_submissions')
			.delete()
			.eq('event_id', personal.boardId)
			.eq('target_id', String(personal.idx))
			.eq('status', 'approved')
			.eq('source', 'dink');
		if (delErr) return { ok: false, error: delErr.message };
		await sb.from('vs_dink_drops').update({ outcome: 'reverted' }).eq('id', dropId);
		return { ok: true };
	}

	// Event credit: derive the user + tile, then delete the auto-tracked approved completion.
	if (!row.event_id) return { ok: false, error: 'Drop has no event' };

	// Connect Four keeps its credit as a PIECE on the board, not a completion row, and
	// removing one has rules of its own (only the top of a column can go, and the game may
	// have to reopen). Send the admin to the tester rather than half-undoing it here.
	const { data: evRow } = await sb.from('vs_events').select('kind, slug').eq('id', row.event_id).maybeSingle();
	const ev = evRow as { kind: string; slug: string } | null;
	if (ev?.kind === CONNECT4_KIND) {
		return { ok: false, error: `Undo this from the Connect Four tester: /admin/connect4/${ev.slug}` };
	}
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
		.select('id, event_id, rsn, item_id, item_name, quantity, received_at, notif_type, image_url, value, source, drop_key')
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
	// `board` is null for event kinds that don't have a bingo board (Connect Four scores
	// from its own piece table); creditEvent is the only reader and refuses without one.
	type EventCtx = { kind: string; start: string | null; status: string; slug: string; name: string; board: Awaited<ReturnType<typeof loadEventBoard>> | null };
	const eventCache = new Map<string, EventCtx | null>();

	// Per drop: the verdict + the tile/event it was attributed to (persisted so collect-N
	// partials stay tile-scoped and an admin revert can find them).
	const outcomeById = new Map<number, Outcome>();
	const tileIdByDrop = new Map<number, string>();
	const eventIdByDrop = new Map<number, string>();
	const feedPosts: { by: string; tileName: string; eventName: string; eventSlug: string; via: string | null }[] = [];
	let credited = 0;

	// The player's currently-active COMPLETABLE item tiles (open-event tiles + their personal
	// board), from the shared allowlist module (which reads the live view and excludes
	// allowlist-only kind='pin' rows). The drop is matched against THIS user's tiles only — so
	// credit is per-user-correct (a drop only ever completes the dropper's own tiles). Cached.
	async function objectivesFor(userId: string): Promise<ActiveItemTile[]> {
		const hit = objectivesByUser.get(userId);
		if (hit) return hit;
		const list = await getTrackedItemsForUser(userId);
		objectivesByUser.set(userId, list);
		return list;
	}

	async function eventCtxFor(eventId: string): Promise<EventCtx | null> {
		if (eventCache.has(eventId)) return eventCache.get(eventId) ?? null;
		const { data: e } = await sb
			.from('vs_events')
			.select('id, kind, slug, name, status, structure, starts_at, signup_opens_at')
			.eq('id', eventId)
			.maybeSingle();
		if (!e) { eventCache.set(eventId, null); return null; }
		const ev = e as { id: string; kind: string; slug: string; name: string; status: string; structure: unknown; starts_at: string | null; signup_opens_at: string | null };
		// Connect Four scores from its own piece table, not a bingo board — skip the board
		// load, which would find no structure to read anyway.
		const board = ev.kind === CONNECT4_KIND ? null : await loadEventBoard(ev);
		const ctx: EventCtx = { kind: ev.kind, start: ev.starts_at ?? ev.signup_opens_at, status: ev.status, slug: ev.slug, name: ev.name, board };
		eventCache.set(eventId, ctx);
		return ctx;
	}

	type CandResult = Outcome | 'retry'; // 'retry' = transient error → leave drop unprocessed

	// One candidate, routed to whatever owns it. The event's `kind` picks the scorer, so
	// adding an event type never touches the matching or the batching around this.
	async function creditCandidate(drop: DropRow, cand: ActiveItemTile, userId: string): Promise<CandResult> {
		if (cand.kind === 'personal') return creditPersonal(drop, cand);
		const ctx = await eventCtxFor(cand.event_id as string);
		if (ctx?.kind === CONNECT4_KIND) return creditConnect4(drop, cand, userId);
		return creditEvent(drop, cand, userId);
	}

	// Credit one PERSONAL board tile: activation rule, then flip obtained (shared helper).
	async function creditPersonal(drop: DropRow, cand: ActiveItemTile): Promise<CandResult> {
		// A drop obtained BEFORE the board (tile) became active never credits it.
		if (cand.activated_at && new Date(drop.received_at).getTime() < new Date(cand.activated_at).getTime())
			return 'timing';
		const res = await creditPersonalTile(cand.board_id as string, cand.board_idx as number, cand.user_id as string, {
			// The Dink screenshot (when the client attached one) doubles as the proof image.
			proofUrls: drop.image_url ? [drop.image_url] : undefined,
			targetLabel: drop.item_name ?? undefined
		});
		if (res === 'error') return 'retry';
		return res === 'credited' ? 'credited' : 'duplicate';
	}

	// Connect Four: the drop claims the shared tile above a column for the DROPPER'S SIDE.
	// Both clans chase the same 25 tiles, so two drops can want the same one; who gets it is
	// settled by the pieces table's unique (event_id, col, row) index inside `claimTile`,
	// never here. Cached per (event, user) for the batch, same as objectives.
	// One check per batch: with no game running, the "did this drop already claim a tile?"
	// lookup below is skipped entirely and costs nothing.
	let c4Running: boolean | null = null;
	async function anyConnect4Running(): Promise<boolean> {
		if (c4Running === null) {
			try {
				c4Running = await anyLiveConnect4();
			} catch {
				c4Running = false;
			}
		}
		return c4Running;
	}

	const c4SideCache = new Map<string, 1 | 2 | null>();
	async function connect4SideFor(eventId: string, userId: string): Promise<1 | 2 | null> {
		const key = `${eventId}|${userId}`;
		if (c4SideCache.has(key)) return c4SideCache.get(key) ?? null;
		let side: 1 | 2 | null = null;
		try {
			side = await sideForUser(eventId, userId);
		} catch (e) {
			console.warn('[dink] connect4 side lookup failed:', e instanceof Error ? e.message : e);
		}
		c4SideCache.set(key, side);
		return side;
	}

	async function creditConnect4(drop: DropRow, cand: ActiveItemTile, userId: string): Promise<CandResult> {
		const eventId = cand.event_id as string;
		const side = await connect4SideFor(eventId, userId);
		// Signed up but not yet on a side — never guess which clan a drop belongs to.
		if (!side) return 'no_tile';
		// The drop key IS the idempotency guard. Without one, the reconcile pass would drop
		// a second piece for the same drop every time it re-ran, so claim nothing.
		if (!drop.drop_key) return 'no_tile';
		const res = await claimTile({
			eventId,
			side,
			dropKey: drop.drop_key,
			itemId: drop.item_id,
			itemName: drop.item_name,
			byUserId: userId,
			receivedAt: drop.received_at
		});
		switch (res.status) {
			case 'claimed':
				return 'credited';
			// `raced` means another player claimed that tile first. Nothing is owed, and no
			// re-run can change that, so it is terminal like a duplicate rather than
			// 'no_tile' — which the reconcile pass would re-surface for three days. Stamped
			// distinctly so /admin/dink-drops tells the story straight.
			case 'raced':
				return 'raced';
			case 'duplicate':
				return 'duplicate';
			case 'timing':
				return 'timing';
			case 'error':
				return 'retry';
			default:
				return 'no_tile';
		}
	}

	// Credit one EVENT tile: timing gate (= activation), idempotency, collect-N, then the
	// approved-completion insert (unchanged hardening). Queues a feed post on success.
	async function creditEvent(drop: DropRow, cand: ActiveItemTile, userId: string): Promise<CandResult> {
		const eventId = cand.event_id as string;
		const tileId = cand.tile_id as string;
		const ctx = await eventCtxFor(eventId);
		if (!ctx?.board) return 'no_tile';
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
			// The Dink screenshot (when attached) becomes the reviewable proof image.
			proof_url: '', proof_path: '', proof_urls: drop.image_url ? [drop.image_url] : [], proof_paths: [],
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
	const RANK: Record<string, number> = { credited: 5, partial: 4, duplicate: 3, raced: 3, timing: 2, no_user: 1, no_tile: 0, consumed: 0, reverted: 0, bomb: 0 };

	// Battleship arms on VALUE, not on a tracked item, so it can't ride the tile index —
	// it's a separate per-drop check. Cached per user for the batch, same as objectives.
	const battleshipByUser = new Map<string, Awaited<ReturnType<typeof activeBattleshipFor>>>();
	async function battleshipFor(userId: string) {
		if (battleshipByUser.has(userId)) return battleshipByUser.get(userId) ?? null;
		let game: Awaited<ReturnType<typeof activeBattleshipFor>> = null;
		try {
			game = await activeBattleshipFor(userId);
		} catch (e) {
			// A missing table (schema not applied yet) must not stall the whole drain.
			console.warn('[dink] battleship lookup failed:', e instanceof Error ? e.message : e);
		}
		battleshipByUser.set(userId, game);
		return game;
	}

	for (const drop of rows) {
		const rsnKey = drop.rsn.toLowerCase();
		if (!userIdByRsn.has(rsnKey)) userIdByRsn.set(rsnKey, await resolveUserId(drop.rsn));
		const userId = userIdByRsn.get(rsnKey) ?? null;
		if (!userId) { outcomeById.set(drop.id, 'no_user'); continue; }

		// Arm a bomb BEFORE the tile matching, and independently of it: a drop can both
		// complete a bingo tile and arm a bomb, exactly as it can credit an event tile and
		// a personal-board tile. earnBomb is idempotent on drop_key, so the reconcile pass
		// re-running this drop can never mint a second bomb.
		//
		// COLLECTION rows are excluded. A new collection-log item makes Dink send TWO
		// notifications for one drop: a LOOT one (source = the NPC) and a COLLECTION one
		// (source = "Collection log"), seconds apart. They carry different sources — and
		// sometimes different quantities and values, since the loot row reports the stack
		// and the collection row a single item — so they hash to different drop_keys and
		// earnBomb's idempotency cannot see they are the same drop.
		//
		// Tiles are unaffected and deliberately match either notification, because
		// crediting the same tile twice is a no-op. A bomb is minted PER drop_key, so
		// counting both handed every player two bombs for any drop that also unlocked a
		// collection-log slot — which is most big drops.
		let bombed: { tier: number; eventId: string } | null = null;
		const game = await battleshipFor(userId);
		if (game && drop.drop_key && drop.notif_type !== 'collection') {
			// The activation rule the rest of the pipeline uses: a drop from before the
			// battle opened never arms anything.
			const inWindow =
				!game.startsAt || new Date(drop.received_at).getTime() >= new Date(game.startsAt).getTime();
			if (inWindow) {
				const res = await earnBomb({
					eventId: game.eventId,
					side: game.side,
					userId,
					value: Number(drop.value) || 0,
					dropKey: drop.drop_key,
					itemName: drop.item_name,
					source: drop.source ?? null,
					tiers: game.tiers
				});
				if (res.minted && res.tier) bombed = { tier: res.tier, eventId: game.eventId };
			}
		}

		// WATCH BOTH WAYS: match on item id (preferred) / name regardless of notif_type, so a
		// loot drop OR a collection unlock of the item credits the tile. Idempotency below makes
		// a double-fire safe. (drop.notif_type is still recorded on the row for display/audit.)
		const dname = (drop.item_name ?? '').toLowerCase();
		const candidates = (await objectivesFor(userId)).filter((o) => {
			if (o.item_id != null && drop.item_id != null) return o.item_id === drop.item_id;
			return !!dname && (o.item_name ?? '').toLowerCase() === dname;
		});
		if (candidates.length === 0) {
			// No tile wanted it, but it armed a bomb — say so, so /admin/dink-drops doesn't
			// file a working Battleship drop under "Didn't credit".
			if (bombed) {
				outcomeById.set(drop.id, 'bomb');
				tileIdByDrop.set(drop.id, `bomb:t${bombed.tier}`);
				eventIdByDrop.set(drop.id, bombed.eventId);
				credited += 1;
				continue;
			}
			// A Connect Four drop that already claimed a tile matches NOTHING on a re-run: its
			// column has moved on, so the item has left the allowlist. Without this it would be
			// filed under "Didn't credit" and re-surfaced by every reconcile pass for days.
			const priorClaim = drop.drop_key && (await anyConnect4Running()) ? await pieceForDropKey(drop.drop_key) : null;
			if (priorClaim) {
				outcomeById.set(drop.id, 'duplicate');
				tileIdByDrop.set(drop.id, `col:${priorClaim.col}`);
				eventIdByDrop.set(drop.id, priorClaim.eventId);
				continue;
			}
			// The other way a Connect Four drop matches nothing: SOMEONE ELSE claimed its
			// tile first and the winner's claim removed the item from the allowlist. With 25
			// shared objectives that staggered loss is the common race shape, and it is just
			// as terminal as the tight one — only the first drop for a tile ever counts,
			// whether the winner came through Dink or an admin's manual credit. Stamp it
			// `raced` so the reconcile pass stops re-churning it.
			const lost = (await anyConnect4Running())
				? await racedOutOf({ userId, itemId: drop.item_id, itemName: drop.item_name })
				: null;
			if (lost) {
				outcomeById.set(drop.id, 'raced');
				tileIdByDrop.set(drop.id, `col:${lost.col}`);
				eventIdByDrop.set(drop.id, lost.eventId);
			} else {
				outcomeById.set(drop.id, 'no_tile');
			}
			continue;
		}

		// Credit every matching candidate (a drop may complete an event tile AND a board
		// tile). Track the best outcome; if any candidate hit a transient error, leave the
		// whole drop unprocessed so it retries (re-credit is idempotent).
		let best: Outcome = 'no_tile';
		let bestTile: string | null = null;
		let bestEvent: string | null = null;
		let retry = false;
		for (const cand of candidates) {
			const res = await creditCandidate(drop, cand, userId);
			if (res === 'retry') { retry = true; continue; }
			if (res === 'credited') credited += 1;
			if ((RANK[res] ?? 0) >= (RANK[best] ?? 0)) {
				best = res;
				bestTile = cand.kind === 'personal' ? `p:${cand.board_id}:${cand.board_idx}` : cand.tile_id;
				bestEvent = cand.event_id;
			}
		}
		if (retry) continue; // not added to outcomeById → stays unprocessed → retried
		// A drop that armed a bomb AND matched nothing creditable still reads as a bomb.
		if (bombed && (best === 'no_tile' || best === 'timing')) {
			outcomeById.set(drop.id, 'bomb');
			tileIdByDrop.set(drop.id, `bomb:t${bombed.tier}`);
			eventIdByDrop.set(drop.id, bombed.eventId);
			credited += 1;
			continue;
		}
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

// ——— Drain scheduling ———
//
// Two entry points share one serialized runner:
//   - runProcessDinkDrops: the event-driven path (/api/dink/process — the dink-proxy's
//     after-insert ping and the worker cron). Awaitable; serialized so a burst of pings
//     (a multi-item kill fires one per ingest) can't stampede this instance — one run in
//     flight, and everything that arrives mid-run coalesces into a single follow-up run
//     (reconcile flags OR-ed together) whose promise the coalesced callers share.
//   - maybeProcessDinkDrops: the throttled poll-on-read backstop (board page loads).
//     Never rejects, so a tracking hiccup can't break page rendering. Returns the
//     in-flight run when one exists so a load that wants the freshest read can await it.
// Cross-instance overlap stays safe regardless — crediting is idempotent on drop_key and
// the per-event unique constraints — serializing is about wasted work, not correctness.

type DrainResult = Awaited<ReturnType<typeof processDinkDrops>>;
const swallow = () => {};
let running: Promise<DrainResult> | null = null;
let next: { reconcile: boolean; promise: Promise<DrainResult> } | null = null;

export function runProcessDinkDrops(opts: { reconcile?: boolean } = {}): Promise<DrainResult> {
	const reconcile = opts.reconcile ?? false;
	if (!running) {
		running = processDinkDrops({ reconcile }).finally(() => {
			running = null;
		});
		return running;
	}
	if (next) {
		// A follow-up is already queued: fold this request into it.
		if (reconcile) next.reconcile = true;
		return next.promise;
	}
	const pending = { reconcile } as { reconcile: boolean; promise: Promise<DrainResult> };
	pending.promise = running.then(swallow, swallow).then(() => {
		next = null;
		return runProcessDinkDrops({ reconcile: pending.reconcile });
	});
	next = pending;
	return pending.promise;
}

// Throttled backstop for the poll-on-read path: runs at most once per window per server
// instance. With the proxy ping + worker cron as the primary drain (docs/LIVE-UPDATES.md)
// this is belt-and-braces for environments where those aren't configured.
const THROTTLE_MS = 20_000;
let lastRun = 0;

export function maybeProcessDinkDrops(): Promise<void> {
	if (running) return running.then(swallow, swallow);
	if (Date.now() - lastRun < THROTTLE_MS) return Promise.resolve();
	lastRun = Date.now();
	return runProcessDinkDrops()
		.then(swallow)
		.catch((e) =>
			console.warn('[dinkDrops] background process failed:', e instanceof Error ? e.message : e)
		);
}
