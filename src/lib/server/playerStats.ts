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
