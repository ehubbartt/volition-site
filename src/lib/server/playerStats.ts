import { db } from './db';

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
