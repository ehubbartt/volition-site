// SERVER-ONLY. The single source of truth for "what items should be in a member's Dink
// tracking config right now" — decoupled from any one feature (events, personal boards,
// the connection self-test). Anything that needs a member's tracked-item set, or that
// manages a non-event tracking source, goes through here.
//
// The live SQL view `vs_active_player_tiles` (db/scripts/active_tiles.sql) remains the
// derivation; this module READS it (getTrackedItemsForUser / getTrackedItemsForToken) and
// MANAGES the one event-decoupled source — manual pins in `vs_dink_manual_items` (pinItem
// and the connection self-test). The dink-proxy Worker reads the derived views
// (vs_dink_token_items) directly; this module is the site-side face of the same model.

import { db } from '$lib/server/db';

// One row of vs_active_player_tiles (type='item'). `kind='pin'` rows are allowlist-only
// (they exist to whitelist an item — e.g. the self-test — not to be completed) and must be
// excluded from crediting; getTrackedItemsForUser does that.
export interface ActiveItemTile {
	user_id: string;
	kind: 'event' | 'personal' | 'pin';
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

const TILE_COLS =
	'user_id, kind, event_id, tile_id, board_id, board_idx, item_id, item_name, match_type, required_qty, activated_at';

// The member's currently-active COMPLETABLE item tiles (open + started events plus their
// locked personal board). Excludes kind='pin' allowlist-only rows so a pin can never reach
// the credit path (creditEvent would choke on a null event_id). Reads fail open (empty).
export async function getTrackedItemsForUser(userId: string): Promise<ActiveItemTile[]> {
	const { data, error } = await db()
		.from('vs_active_player_tiles')
		.select(TILE_COLS)
		.eq('user_id', userId)
		.eq('type', 'item')
		.neq('kind', 'pin');
	if (error) {
		console.error('[dink-allowlist] tracked-items read failed for', userId, error.message);
		return [];
	}
	return (data ?? []) as ActiveItemTile[];
}

// The items served into a token's Dink loot allowlist — the exact per-token set the proxy
// injects (from vs_dink_token_items). Site-side accessor for admin/debug parity; the proxy
// reads the view directly. Includes pin rows (they SHOULD be in the allowlist). Fail open.
export async function getTrackedItemsForToken(
	token: string
): Promise<{ item_id: number | null; item_name: string; match_type: string }[]> {
	const { data, error } = await db()
		.from('vs_dink_token_items')
		.select('item_id, item_name, match_type')
		.eq('token', token);
	if (error) {
		console.error('[dink-allowlist] per-token items read failed:', error.message);
		return [];
	}
	return (data ?? []) as { item_id: number | null; item_name: string; match_type: string }[];
}

// ── Manual pins (event-decoupled tracking) ───────────────────────────────────
// A pin puts one item in a member's served allowlist for a while (or permanently),
// independent of events/boards. Expiry is declarative (the view drops expired pins), so
// there is no cleanup job. Writes swallow + log so a pin failure never breaks the request.

export interface PinOpts {
	userId: string;
	itemId: number;
	itemName: string;
	matchType?: string; // display/intent only; matching watches both ways
	ttlMs?: number | null; // omit/null = permanent pin
	reason?: string;
}

export async function pinItem(opts: PinOpts): Promise<void> {
	const expires_at = opts.ttlMs != null ? new Date(Date.now() + opts.ttlMs).toISOString() : null;
	const { error } = await db()
		.from('vs_dink_manual_items')
		.upsert(
			{
				user_id: opts.userId,
				item_id: opts.itemId,
				item_name: opts.itemName,
				match_type: opts.matchType ?? 'loot',
				expires_at,
				reason: opts.reason ?? null
			},
			{ onConflict: 'user_id,item_id' }
		);
	if (error)
		console.error('[dink-allowlist] pinItem failed for', opts.userId, opts.itemId, error.message);
}

export async function unpinItem(userId: string, itemId: number): Promise<void> {
	const { error } = await db()
		.from('vs_dink_manual_items')
		.delete()
		.eq('user_id', userId)
		.eq('item_id', itemId);
	if (error) console.error('[dink-allowlist] unpinItem failed for', userId, itemId, error.message);
}

export async function listPins(userId: string) {
	const { data } = await db()
		.from('vs_dink_manual_items')
		.select('item_id, item_name, match_type, expires_at, reason, created_at')
		.eq('user_id', userId);
	return data ?? [];
}

// ── Connection self-test (Bones) ─────────────────────────────────────────────
// /dink-check pins Bones for the visiting member with a short, refreshed TTL, so Bones sits
// in their served allowlist only while they're actively testing. No fake event, no signup,
// no prune job — the pin expires declaratively.
export const SELF_TEST_ITEM = { id: 526, name: 'Bones' };
export const SELF_TEST_TTL_MS = 90 * 60 * 1000; // 90 min — matches the /dink-check drops window
const SELF_TEST_REASON = 'self-test';

export async function pinSelfTest(userId: string): Promise<void> {
	await pinItem({
		userId,
		itemId: SELF_TEST_ITEM.id,
		itemName: SELF_TEST_ITEM.name,
		matchType: 'loot',
		ttlMs: SELF_TEST_TTL_MS,
		reason: SELF_TEST_REASON
	});
}

// Drop the self-test pin once the pipeline is proven (a verifying Bones drop landed) — only
// the self-test pin, never a deliberate clan-watch pin of the same item.
export async function clearSelfTestPin(userId: string): Promise<void> {
	const { error } = await db()
		.from('vs_dink_manual_items')
		.delete()
		.eq('user_id', userId)
		.eq('item_id', SELF_TEST_ITEM.id)
		.eq('reason', SELF_TEST_REASON);
	if (error) console.error('[dink-allowlist] clearSelfTestPin failed for', userId, error.message);
}
