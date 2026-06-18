import { db } from './db';
import { itemPrice } from '$lib/gp';

// Reads player-facing currency + loot from the Discord bot's tables, which live
// in the same Supabase project (see voli-disc-bot/db/CLAUDE.md). These are owned
// by the bot — the site only reads them here.
//
// VP ("Volition Points") = players.points, keyed by discord_id with an rsn
// fallback (mirrors isClanMember in clan.ts, since not every row has a discord_id).
// Wallet = wallet_items, the unpaid lootcrate ("gamble box") drops, keyed by the
// Discord user id.

export interface WalletItem {
	name: string;
	quantity: number;
}

export async function getPlayerVp(
	discordId: string | null,
	rsn: string | null
): Promise<number> {
	const sb = db();

	if (discordId) {
		const { data } = await sb
			.from('players')
			.select('points')
			.eq('discord_id', discordId)
			.maybeSingle();
		if (data) return data.points ?? 0;
	}

	if (rsn) {
		const { data } = await sb
			.from('players')
			.select('points')
			.ilike('rsn', rsn)
			.maybeSingle();
		if (data) return data.points ?? 0;
	}

	return 0;
}

// --- VP writes (spend / refund the bot's players.points) -------------------
// Used by the /gamba pack opener. Writing the bot's table is sensitive, so it
// lives next to the read path. There are no transactions through the anon
// client, so the spend uses optimistic concurrency: it only deducts if points
// is still exactly what we just read (otherwise it reports a conflict and the
// caller can retry). Card-granting happens after a successful spend; if that
// fails the caller refunds via grantPlayerVp.

export type SpendResult =
	| { ok: true; balance: number }
	| { ok: false; reason: 'no_player' | 'insufficient' | 'conflict'; balance: number };

// Find the player row the same way getPlayerVp does (discord_id, then rsn), but
// also grab the serial primary key so all writes target that exact row by id
// (rsn's unique constraint is case-sensitive, so an ilike write could touch a
// different-case row — id avoids that).
async function locatePlayer(
	discordId: string | null,
	rsn: string | null
): Promise<{ id: number; points: number } | null> {
	const sb = db();
	if (discordId) {
		const { data } = await sb
			.from('players')
			.select('id, points')
			.eq('discord_id', discordId)
			.maybeSingle();
		if (data) return { id: data.id, points: data.points ?? 0 };
	}
	if (rsn) {
		const { data } = await sb.from('players').select('id, points').ilike('rsn', rsn).maybeSingle();
		if (data) return { id: data.id, points: data.points ?? 0 };
	}
	return null;
}

export async function spendPlayerVp(
	discordId: string | null,
	rsn: string | null,
	amount: number
): Promise<SpendResult> {
	const p = await locatePlayer(discordId, rsn);
	if (!p) return { ok: false, reason: 'no_player', balance: 0 };
	if (p.points < amount) return { ok: false, reason: 'insufficient', balance: p.points };

	// Only deduct if points is unchanged since the read (optimistic lock).
	const { data, error } = await db()
		.from('players')
		.update({ points: p.points - amount })
		.eq('id', p.id)
		.eq('points', p.points)
		.select('points');

	if (error || !data || data.length === 0) return { ok: false, reason: 'conflict', balance: p.points };
	return { ok: true, balance: p.points - amount };
}

// Best-effort add-back used to refund a failed open. Re-reads then writes by id.
export async function grantPlayerVp(
	discordId: string | null,
	rsn: string | null,
	amount: number
): Promise<void> {
	const p = await locatePlayer(discordId, rsn);
	if (!p) return;
	await db()
		.from('players')
		.update({ points: p.points + amount })
		.eq('id', p.id);
}

// --- GP balance (players.gold_balance) ------------------------------------
// A cashable GP balance shared with the bot (sibling of points/VP). Players convert
// their unpaid wallet_items into it (convertWalletToGold) and spend it on packs
// (spendGold); leftover stays redeemable in-game. Same optimistic-lock pattern as VP.

const GP_CONVERSION_MARKER = 'gp_conversion';

export async function getPlayerGold(discordId: string | null, rsn: string | null): Promise<number> {
	const sb = db();
	if (discordId) {
		const { data } = await sb
			.from('players')
			.select('gold_balance')
			.eq('discord_id', discordId)
			.maybeSingle();
		if (data) return (data.gold_balance as number | null) ?? 0;
	}
	if (rsn) {
		const { data } = await sb.from('players').select('gold_balance').ilike('rsn', rsn).maybeSingle();
		if (data) return (data.gold_balance as number | null) ?? 0;
	}
	return 0;
}

async function locatePlayerGold(
	discordId: string | null,
	rsn: string | null
): Promise<{ id: number; gold: number } | null> {
	const sb = db();
	if (discordId) {
		const { data } = await sb
			.from('players')
			.select('id, gold_balance')
			.eq('discord_id', discordId)
			.maybeSingle();
		if (data) return { id: data.id, gold: (data.gold_balance as number | null) ?? 0 };
	}
	if (rsn) {
		const { data } = await sb
			.from('players')
			.select('id, gold_balance')
			.ilike('rsn', rsn)
			.maybeSingle();
		if (data) return { id: data.id, gold: (data.gold_balance as number | null) ?? 0 };
	}
	return null;
}

export async function spendGold(
	discordId: string | null,
	rsn: string | null,
	amount: number
): Promise<SpendResult> {
	const p = await locatePlayerGold(discordId, rsn);
	if (!p) return { ok: false, reason: 'no_player', balance: 0 };
	if (p.gold < amount) return { ok: false, reason: 'insufficient', balance: p.gold };

	const { data, error } = await db()
		.from('players')
		.update({ gold_balance: p.gold - amount })
		.eq('id', p.id)
		.eq('gold_balance', p.gold) // optimistic lock
		.select('gold_balance');

	if (error || !data || data.length === 0) return { ok: false, reason: 'conflict', balance: p.gold };
	return { ok: true, balance: p.gold - amount };
}

// Add to the GP balance (refund a failed open, or credit a conversion). Optimistic
// increment with a few retries — there's no SQL `+=` through the anon client, so we
// re-read + write under a lock, retrying if a concurrent change beat us. Returns the
// new balance, or null if the player row is missing / it couldn't settle.
export async function grantGold(
	discordId: string | null,
	rsn: string | null,
	amount: number
): Promise<number | null> {
	if (amount <= 0) {
		const cur = await locatePlayerGold(discordId, rsn);
		return cur ? cur.gold : null;
	}
	for (let attempt = 0; attempt < 5; attempt++) {
		const p = await locatePlayerGold(discordId, rsn);
		if (!p) return null;
		const { data, error } = await db()
			.from('players')
			.update({ gold_balance: p.gold + amount })
			.eq('id', p.id)
			.eq('gold_balance', p.gold)
			.select('gold_balance');
		if (!error && data && data.length > 0) return p.gold + amount;
	}
	return null; // gave up after retries (extremely rare)
}

export type ConvertResult =
	| { ok: true; gained: number; newBalance: number }
	| { ok: false; reason: 'no_player' | 'empty' | 'error' };

// Converts ALL of a player's unpaid wallet items into GP (players.gold_balance). Marks
// the items paid_out (settled — won't be paid out again in-game) and credits their summed
// itemPrice() value. Race-safe: we read the priced unpaid items, then flip exactly those
// that are STILL unpaid (`.in(id).eq(paid_out,false)`) and credit only the rows we flipped,
// so concurrent conversions can't double-count. Unpriced items are left untouched.
export async function convertWalletToGold(
	discordId: string | null,
	rsn: string | null
): Promise<ConvertResult> {
	if (!discordId) return { ok: false, reason: 'no_player' };
	const sb = db();

	const { data: unpaid, error: readErr } = await sb
		.from('wallet_items')
		.select('id, item_name')
		.eq('user_id', discordId)
		.eq('paid_out', false);
	if (readErr) return { ok: false, reason: 'error' };

	const priced = ((unpaid ?? []) as Array<{ id: string | number; item_name: string }>).filter(
		(i) => itemPrice(i.item_name) > 0
	);
	if (priced.length === 0) return { ok: false, reason: 'empty' };

	const { data: flipped, error: flipErr } = await sb
		.from('wallet_items')
		.update({
			paid_out: true,
			paid_out_at: new Date().toISOString(),
			paid_out_by: GP_CONVERSION_MARKER
		})
		.in(
			'id',
			priced.map((i) => i.id)
		)
		.eq('paid_out', false)
		.select('item_name');
	if (flipErr) return { ok: false, reason: 'error' };

	const rows = (flipped ?? []) as Array<{ item_name: string }>;
	if (rows.length === 0) return { ok: false, reason: 'empty' }; // a concurrent convert got them

	const gained = rows.reduce((sum, r) => sum + itemPrice(r.item_name), 0);
	const newBalance = await grantGold(discordId, rsn, gained);
	if (newBalance == null) {
		console.error('[gp-convert] settled items but could not credit GP for', discordId);
		return { ok: false, reason: 'error' };
	}
	return { ok: true, gained, newBalance };
}

// Returns the user's unpaid wallet drops grouped by item name (most recent first).
export async function getWalletItems(discordId: string | null): Promise<WalletItem[]> {
	if (!discordId) return [];

	const { data, error } = await db()
		.from('wallet_items')
		.select('item_name, won_at')
		.eq('user_id', discordId)
		.eq('paid_out', false)
		.order('won_at', { ascending: false });

	if (error || !data) return [];

	const counts = new Map<string, number>();
	for (const row of data) {
		const name = row.item_name as string;
		counts.set(name, (counts.get(name) ?? 0) + 1);
	}

	return Array.from(counts, ([name, quantity]) => ({ name, quantity }));
}

// --- Lootcrate free daily claim -------------------------------------------
// The free daily crate is tracked by players.last_loot_date (a date), shared with
// the bot — claiming on the site or in Discord uses that UTC day's free open.

// Reads the player's last free-claim date (YYYY-MM-DD string) or null.
export async function getLastLootDate(
	discordId: string | null,
	rsn: string | null
): Promise<string | null> {
	const sb = db();
	if (discordId) {
		const { data } = await sb
			.from('players')
			.select('last_loot_date')
			.eq('discord_id', discordId)
			.maybeSingle();
		if (data) return (data.last_loot_date as string | null) ?? null;
	}
	if (rsn) {
		const { data } = await sb.from('players').select('last_loot_date').ilike('rsn', rsn).maybeSingle();
		if (data) return (data.last_loot_date as string | null) ?? null;
	}
	return null;
}

export type FreeClaimResult = { ok: true } | { ok: false; reason: 'no_player' | 'already' | 'error' };

// Atomically claims today's free crate: sets last_loot_date=todayUtc ONLY if it
// isn't already today (the concurrency guard against double-claim). The caller
// grants the rolled winnings (VP/item) after a successful claim.
export async function claimFreeLootDay(
	discordId: string | null,
	rsn: string | null,
	todayUtc: string
): Promise<FreeClaimResult> {
	const sb = db();

	// Locate the player row + its current claim date (by id, so the write targets
	// exactly one row — same reasoning as locatePlayer).
	let row: { id: number; last_loot_date: string | null } | null = null;
	if (discordId) {
		const { data } = await sb
			.from('players')
			.select('id, last_loot_date')
			.eq('discord_id', discordId)
			.maybeSingle();
		if (data) row = data as { id: number; last_loot_date: string | null };
	}
	if (!row && rsn) {
		const { data } = await sb
			.from('players')
			.select('id, last_loot_date')
			.ilike('rsn', rsn)
			.maybeSingle();
		if (data) row = data as { id: number; last_loot_date: string | null };
	}
	if (!row) return { ok: false, reason: 'no_player' };
	if (row.last_loot_date === todayUtc) return { ok: false, reason: 'already' };

	// Optimistic claim: only set today's date if last_loot_date is still what we
	// read (handles null vs a prior date without a LIKE/or filter). A concurrent
	// claim changes the value and updates 0 rows ⇒ 'already'.
	let q = sb.from('players').update({ last_loot_date: todayUtc }).eq('id', row.id);
	q = row.last_loot_date === null ? q.is('last_loot_date', null) : q.eq('last_loot_date', row.last_loot_date);
	const { data, error } = await q.select('id');

	if (error) {
		console.error('[free-claim] update failed:', error.message);
		return { ok: false, reason: 'error' };
	}
	if (!data || data.length === 0) return { ok: false, reason: 'already' };
	return { ok: true };
}
