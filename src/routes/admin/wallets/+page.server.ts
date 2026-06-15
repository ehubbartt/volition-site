import { redirect, error } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { isAdmin } from '$lib/server/auth';
import { itemPrice } from '$lib/gp';
import type { PageServerLoad } from './$types';

// Wallet panel (migrated from volition-admin-dashboard). Reads the bot's players +
// wallet_items roster: each player's VP balance plus the GP value of the unpaid
// loot-crate items waiting in their wallet. Read-only — payouts happen in-game/bot-side.

export type WalletItem = {
	id: string | number;
	item_name: string;
	paid_out: boolean;
	won_at: string | null;
	paid_out_at: string | null;
	paid_out_by: string | null;
	price: number;
};

export type WalletPlayer = {
	id: string | number;
	discord_id: string | null;
	rsn: string | null;
	points: number;
	clan_joined_at: string | null;
	rank: string | null;
	unpaidCount: number;
	totalItems: number;
	walletValue: number;
	items: WalletItem[];
};

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) throw redirect(303, '/');
	if (!isAdmin(locals.user)) throw error(403, 'Not allowed');

	const [{ data: players }, { data: items }] = await Promise.all([
		db().from('players').select('id, discord_id, rsn, points, clan_joined_at, rank'),
		db()
			.from('wallet_items')
			.select('id, user_id, item_name, paid_out, won_at, paid_out_at, paid_out_by')
			.order('won_at', { ascending: false })
	]);

	// wallet_items.user_id is the player's Discord id (string); fall back to the serial id.
	const byUser = new Map<string, WalletItem[]>();
	for (const it of items ?? []) {
		const key = String((it as { user_id: string | number }).user_id);
		const arr = byUser.get(key) ?? [];
		arr.push({
			id: (it as { id: string | number }).id,
			item_name: (it as { item_name: string }).item_name,
			paid_out: !!(it as { paid_out?: boolean }).paid_out,
			won_at: (it as { won_at?: string | null }).won_at ?? null,
			paid_out_at: (it as { paid_out_at?: string | null }).paid_out_at ?? null,
			paid_out_by: (it as { paid_out_by?: string | null }).paid_out_by ?? null,
			price: itemPrice((it as { item_name: string }).item_name)
		});
		byUser.set(key, arr);
	}

	const enriched: WalletPlayer[] = (players ?? []).map((p) => {
		const row = p as {
			id: string | number;
			discord_id: string | null;
			rsn: string | null;
			points: number | null;
			clan_joined_at: string | null;
			rank: string | null;
		};
		const its = byUser.get(String(row.discord_id)) ?? byUser.get(String(row.id)) ?? [];
		const unpaid = its.filter((i) => !i.paid_out);
		const walletValue = unpaid.reduce((s, i) => s + i.price, 0);
		return {
			id: row.id,
			discord_id: row.discord_id,
			rsn: row.rsn,
			points: row.points ?? 0,
			clan_joined_at: row.clan_joined_at,
			rank: row.rank,
			unpaidCount: unpaid.length,
			totalItems: its.length,
			walletValue,
			items: its
		};
	});

	const totals = {
		members: enriched.length,
		totalVP: enriched.reduce((s, p) => s + p.points, 0),
		unpaidItems: enriched.reduce((s, p) => s + p.unpaidCount, 0),
		walletValue: enriched.reduce((s, p) => s + p.walletValue, 0)
	};

	return { players: enriched, totals };
};
