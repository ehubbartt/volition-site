import { redirect, error } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { isAdmin } from '$lib/server/auth';
import { itemPrice } from '$lib/gp';
import type { PageServerLoad } from './$types';

// Clan stats dashboard (migrated from volition-admin-dashboard home page). A read-only
// overview of clan + economy + loot-crate activity, sourced from the bot's tables.

const DAY = 86_400_000;
const dayStr = (d: Date | number | string) => new Date(d).toISOString().split('T')[0];

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) throw redirect(303, '/');
	if (!isAdmin(locals.user)) throw error(403, 'Not allowed');

	const now = Date.now();
	const since90 = new Date(now - 90 * DAY).toISOString();
	const since30 = new Date(now - 30 * DAY).toISOString();
	const sevenDaysAgo = now - 7 * DAY;

	const [
		{ data: players },
		{ data: walletItems },
		rareTotal,
		rareFree,
		rarePaid,
		rareItem,
		rareVp,
		{ data: dailyMetrics },
		{ data: recentRare },
		{ data: rareTrend },
		{ data: reroll },
		{ data: leavers }
	] = await Promise.all([
		db().from('players').select('id, points, clan_joined_at, last_loot_date, discord_id, rsn, rank'),
		db().from('wallet_items').select('user_id, item_name, paid_out'),
		db().from('lootcrate_rare_drops').select('*', { count: 'exact', head: true }),
		db().from('lootcrate_rare_drops').select('*', { count: 'exact', head: true }).eq('was_free', true),
		db().from('lootcrate_rare_drops').select('*', { count: 'exact', head: true }).eq('was_free', false),
		db().from('lootcrate_rare_drops').select('*', { count: 'exact', head: true }).eq('drop_type', 'item'),
		db().from('lootcrate_rare_drops').select('*', { count: 'exact', head: true }).eq('drop_type', 'vp'),
		db().from('lootcrate_daily_metrics').select('*').order('date', { ascending: false }).limit(30),
		db()
			.from('lootcrate_rare_drops')
			.select('id, user_id, item_name, drop_type, amount, chance_percent, was_free, timestamp')
			.order('timestamp', { ascending: false })
			.limit(10),
		db()
			.from('lootcrate_rare_drops')
			.select('item_name, drop_type, was_free, timestamp')
			.gte('timestamp', since30)
			.order('timestamp', { ascending: true }),
		db().from('reroll_tokens').select('id, user_id'),
		db().from('clan_leavers').select('left_at').gte('left_at', since90)
	]);

	const ps = (players ?? []) as Array<{
		id: string | number;
		points: number | null;
		clan_joined_at: string | null;
		last_loot_date: string | null;
		discord_id: string | null;
		rsn: string | null;
		rank: string | null;
	}>;
	const rsnByDiscord = new Map(ps.map((p) => [String(p.discord_id), p.rsn]));

	// Member stats
	const totalMembers = ps.length;
	const totalVP = ps.reduce((s, p) => s + (p.points ?? 0), 0);
	const avgVP = totalMembers > 0 ? Math.round(totalVP / totalMembers) : 0;
	const recentJoins = ps.filter((p) => p.clan_joined_at && now - new Date(p.clan_joined_at).getTime() <= 30 * DAY).length;
	const playersWithVP = ps.filter((p) => (p.points ?? 0) > 0).length;
	const recentLooters = ps.filter((p) => p.last_loot_date && new Date(p.last_loot_date).getTime() >= sevenDaysAgo).length;

	// Joins / leaves by day (90d, filled)
	const joinMap: Record<string, number> = {};
	for (const p of ps) {
		if (p.clan_joined_at && new Date(p.clan_joined_at).getTime() >= now - 90 * DAY) {
			const k = dayStr(p.clan_joined_at);
			joinMap[k] = (joinMap[k] ?? 0) + 1;
		}
	}
	const leaveMap: Record<string, number> = {};
	for (const l of leavers ?? []) {
		const la = (l as { left_at?: string }).left_at;
		if (la) {
			const k = dayStr(la);
			leaveMap[k] = (leaveMap[k] ?? 0) + 1;
		}
	}
	const flow: { date: string; joins: number; leaves: number }[] = [];
	for (let i = 89; i >= 0; i--) {
		const k = dayStr(now - i * DAY);
		flow.push({ date: k, joins: joinMap[k] ?? 0, leaves: leaveMap[k] ?? 0 });
	}

	// Rank distribution
	const rankMap: Record<string, number> = {};
	for (const p of ps) {
		const r = p.rank || 'Unranked';
		rankMap[r] = (rankMap[r] ?? 0) + 1;
	}
	const rankDistribution = Object.entries(rankMap)
		.map(([rank, count]) => ({ rank, count }))
		.sort((a, b) => b.count - a.count);

	// Top players by VP
	const topPlayers = [...ps]
		.sort((a, b) => (b.points ?? 0) - (a.points ?? 0))
		.slice(0, 10)
		.map((p) => ({ rsn: p.rsn || 'Unknown', points: p.points ?? 0 }));

	// Wallet
	const wItems = (walletItems ?? []) as Array<{ user_id: string | number; item_name: string; paid_out: boolean }>;
	const unpaid = wItems.filter((i) => !i.paid_out);
	const walletValue = unpaid.reduce((s, i) => s + itemPrice(i.item_name), 0);
	const byUserVal: Record<string, { value: number; count: number }> = {};
	for (const i of unpaid) {
		const uid = String(i.user_id);
		if (!byUserVal[uid]) byUserVal[uid] = { value: 0, count: 0 };
		byUserVal[uid].value += itemPrice(i.item_name);
		byUserVal[uid].count++;
	}
	const payoutQueue = Object.entries(byUserVal)
		.map(([uid, d]) => ({ rsn: rsnByDiscord.get(uid) || 'Unknown', value: d.value, count: d.count }))
		.sort((a, b) => b.value - a.value)
		.slice(0, 10);

	// Loot-crate daily metrics aggregation
	const metrics = (dailyMetrics ?? []) as Array<Record<string, number | string>>;
	const sum = (rows: typeof metrics, key: string) => rows.reduce((s, d) => s + (Number(d[key]) || 0), 0);
	const last7 = metrics.filter((d) => new Date(String(d.date)).getTime() >= sevenDaysAgo);
	const crate7 = {
		opens: sum(last7, 'total_opens'),
		freeOpens: sum(last7, 'free_opens'),
		paidOpens: sum(last7, 'paid_opens'),
		vpWon: sum(last7, 'total_vp_won'),
		vpSpent: sum(last7, 'total_vp_spent')
	};
	const crate30 = {
		opens: sum(metrics, 'total_opens'),
		freeOpens: sum(metrics, 'free_opens'),
		paidOpens: sum(metrics, 'paid_opens'),
		vpWon: sum(metrics, 'total_vp_won'),
		vpSpent: sum(metrics, 'total_vp_spent')
	};
	const avgOpensPerDay = metrics.length > 0 ? Math.round(crate30.opens / metrics.length) : 0;

	// Rare-drop trend (30d, filled)
	const trendMap: Record<string, number> = {};
	for (const d of rareTrend ?? []) {
		const ts = (d as { timestamp?: string }).timestamp;
		if (ts) {
			const k = dayStr(ts);
			trendMap[k] = (trendMap[k] ?? 0) + 1;
		}
	}
	const rareByDay: { date: string; count: number }[] = [];
	for (let i = 29; i >= 0; i--) {
		const k = dayStr(now - i * DAY);
		rareByDay.push({ date: k, count: trendMap[k] ?? 0 });
	}

	const recentRareDrops = ((recentRare ?? []) as Array<{
		id: string | number;
		user_id: string | number;
		item_name: string;
		drop_type: string;
		amount: number | null;
		chance_percent: number | null;
		was_free: boolean;
		timestamp: string;
	}>).map((d) => ({
		id: d.id,
		rsn: rsnByDiscord.get(String(d.user_id)) || 'Unknown',
		itemName: d.item_name,
		dropType: d.drop_type,
		amount: d.amount,
		chancePercent: d.chance_percent,
		wasFree: d.was_free,
		timestamp: d.timestamp
	}));

	const rerollRows = (reroll ?? []) as Array<{ user_id: string | number }>;

	return {
		members: { totalMembers, totalVP, avgVP, recentJoins, playersWithVP, recentLooters },
		flow,
		rankDistribution,
		topPlayers,
		wallet: { walletValue, unpaidCount: unpaid.length, payoutQueue },
		lootcrates: {
			total: rareTotal.count ?? 0,
			free: rareFree.count ?? 0,
			paid: rarePaid.count ?? 0,
			item: rareItem.count ?? 0,
			vp: rareVp.count ?? 0
		},
		crate7,
		crate30,
		avgOpensPerDay,
		rareByDay,
		recentRareDrops,
		reroll: { total: rerollRows.length, holders: new Set(rerollRows.map((r) => String(r.user_id))).size }
	};
};
