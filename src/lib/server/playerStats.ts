import { db } from './db';
import { itemPrice } from '$lib/gp';
import { rsnExactPattern } from './users';
import { postOpsAlert } from './opsAlert';

// Locate a player row by discord_id first, then by an escaped, case-insensitive
// rsn match (OSRS treats space/underscore as equal — see rsnExactPattern). One
// shared lookup so every read/write below resolves the SAME row the same way and
// can't be fooled by a `_`/`%` in the rsn. `columns` is a Supabase select string;
// the row is returned untyped (callers read the columns they asked for).
async function findPlayerRow(
	discordId: string | null,
	rsn: string | null,
	columns: string
): Promise<Record<string, unknown> | null> {
	const sb = db();
	if (discordId) {
		const { data } = await sb.from('players').select(columns).eq('discord_id', discordId).maybeSingle();
		if (data) return data as unknown as Record<string, unknown>;
	}
	if (rsn) {
		const { data } = await sb
			.from('players')
			.select(columns)
			.ilike('rsn', rsnExactPattern(rsn))
			.maybeSingle();
		if (data) return data as unknown as Record<string, unknown>;
	}
	return null;
}

const num = (v: unknown): number => (typeof v === 'number' ? v : 0);

// Optimistic-lock numeric write: set `column` to `next` only if it's still `prev`
// (no SQL `+=`/transactions through the anon client). Returns true if it landed the
// row. Shared by the VP/GP spend + grant paths so the concurrency guard is identical.
async function casColumn(
	id: number,
	column: 'points' | 'gold_balance',
	prev: number,
	next: number
): Promise<boolean> {
	const { data, error } = await db()
		.from('players')
		.update({ [column]: next })
		.eq('id', id)
		.eq(column, prev)
		.select('id');
	return !error && !!data && data.length > 0;
}

// Optimistic increment with a few retries: re-read + CAS-write, retrying if a
// concurrent change beat us. Returns the new balance, or null if the row is missing
// or it couldn't settle. Shared by grantPlayerVp (refund) and grantGold.
async function grantColumn(
	discordId: string | null,
	rsn: string | null,
	column: 'points' | 'gold_balance',
	amount: number
): Promise<number | null> {
	if (amount <= 0) {
		const cur = await findPlayerRow(discordId, rsn, `id, ${column}`);
		return cur ? num(cur[column]) : null;
	}
	for (let attempt = 0; attempt < 5; attempt++) {
		const cur = await findPlayerRow(discordId, rsn, `id, ${column}`);
		if (!cur) return null;
		const prev = num(cur[column]);
		if (await casColumn(cur.id as number, column, prev, prev + amount)) return prev + amount;
	}
	return null; // gave up after retries (extremely rare)
}

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
	const row = await findPlayerRow(discordId, rsn, 'points');
	return row ? num(row.points) : 0;
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

export async function spendPlayerVp(
	discordId: string | null,
	rsn: string | null,
	amount: number
): Promise<SpendResult> {
	const p = await findPlayerRow(discordId, rsn, 'id, points');
	if (!p) return { ok: false, reason: 'no_player', balance: 0 };
	const points = num(p.points);
	if (points < amount) return { ok: false, reason: 'insufficient', balance: points };

	// Only deduct if points is unchanged since the read (optimistic lock).
	if (!(await casColumn(p.id as number, 'points', points, points - amount)))
		return { ok: false, reason: 'conflict', balance: points };
	return { ok: true, balance: points - amount };
}

// Best-effort add-back used to refund a failed open. Uses the same optimistic
// increment-with-retry as grantGold so two concurrent refunds can't lose an
// increment (a plain read-then-write here previously dropped points under a race).
export async function grantPlayerVp(
	discordId: string | null,
	rsn: string | null,
	amount: number
): Promise<void> {
	await grantColumn(discordId, rsn, 'points', amount);
}

// --- Rank write (players.rank) --------------------------------------------
// The site is the source of truth for clan rank: the on-profile "Check my rank"
// action and the admin rank-sim "apply" write the computed womRole here, and the
// bot mirrors it onto the Discord role (it no longer computes rank from EHB).
// Locate the row by discord_id then rsn (same precedence as locatePlayer) and write
// by id so a case-insensitive rsn match can't touch the wrong row.
export type RankWriteResult = { ok: true; rank: string } | { ok: false; reason: 'no_player' | 'error' };

export async function getPlayerRank(
	discordId: string | null,
	rsn: string | null
): Promise<string | null> {
	const row = await findPlayerRow(discordId, rsn, 'rank');
	return row ? ((row.rank as string | null) ?? null) : null;
}

export async function setPlayerRank(
	discordId: string | null,
	rsn: string | null,
	womRole: string
): Promise<RankWriteResult> {
	const row = await findPlayerRow(discordId, rsn, 'id');
	if (!row) return { ok: false, reason: 'no_player' };

	const { error } = await db().from('players').update({ rank: womRole }).eq('id', row.id as number);
	if (error) return { ok: false, reason: 'error' };
	return { ok: true, rank: womRole };
}

// --- GP balance (players.gold_balance) ------------------------------------
// A cashable GP balance shared with the bot (sibling of points/VP). Players convert
// their unpaid wallet_items into it (convertWalletToGold) and spend it on packs
// (spendGold); leftover stays redeemable in-game. Same optimistic-lock pattern as VP.

const GP_CONVERSION_MARKER = 'gp_conversion';

export async function getPlayerGold(discordId: string | null, rsn: string | null): Promise<number> {
	const row = await findPlayerRow(discordId, rsn, 'gold_balance');
	return row ? num(row.gold_balance) : 0;
}

export async function spendGold(
	discordId: string | null,
	rsn: string | null,
	amount: number
): Promise<SpendResult> {
	const p = await findPlayerRow(discordId, rsn, 'id, gold_balance');
	if (!p) return { ok: false, reason: 'no_player', balance: 0 };
	const gold = num(p.gold_balance);
	if (gold < amount) return { ok: false, reason: 'insufficient', balance: gold };

	if (!(await casColumn(p.id as number, 'gold_balance', gold, gold - amount)))
		return { ok: false, reason: 'conflict', balance: gold };
	return { ok: true, balance: gold - amount };
}

// Add to the GP balance (refund a failed open, or credit a conversion).
export async function grantGold(
	discordId: string | null,
	rsn: string | null,
	amount: number
): Promise<number | null> {
	return grantColumn(discordId, rsn, 'gold_balance', amount);
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
		.select('id, item_name');
	if (flipErr) return { ok: false, reason: 'error' };

	const rows = (flipped ?? []) as Array<{ id: string | number; item_name: string }>;
	if (rows.length === 0) return { ok: false, reason: 'empty' }; // a concurrent convert got them

	const gained = rows.reduce((sum, r) => sum + itemPrice(r.item_name), 0);
	const newBalance = await grantGold(discordId, rsn, gained);
	if (newBalance == null) {
		// We already settled the items but couldn't credit the GP. Roll the settle back
		// so the value isn't lost (items stay claimable), and alert — this is exactly the
		// money-losing event ops should see, not just a console line.
		const { error: rollbackErr } = await sb
			.from('wallet_items')
			.update({ paid_out: false, paid_out_at: null, paid_out_by: null })
			.in(
				'id',
				rows.map((r) => r.id)
			);
		console.error('[gp-convert] settled items but could not credit GP for', discordId);
		postOpsAlert({
			title: 'GP conversion failed after settling wallet items',
			detail: rollbackErr
				? 'Rollback ALSO failed — items may be stuck paid_out with no GP credited.'
				: 'Items were rolled back to unpaid; the player kept their items.',
			fields: [
				{ name: 'User', value: String(discordId) },
				{ name: 'GP not credited', value: String(gained) },
				{ name: 'Items', value: String(rows.length) }
			]
		});
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
	const row = await findPlayerRow(discordId, rsn, 'last_loot_date');
	return row ? ((row.last_loot_date as string | null) ?? null) : null;
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
	// exactly one row — same shared lookup as the other player reads/writes).
	const found = await findPlayerRow(discordId, rsn, 'id, last_loot_date');
	if (!found) return { ok: false, reason: 'no_player' };
	const row = { id: found.id as number, last_loot_date: (found.last_loot_date as string | null) ?? null };
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
