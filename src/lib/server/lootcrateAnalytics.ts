import { db } from './db';
import type { LootResult } from './lootcrate';

// Best-effort mirror of the bot's lootcrate analytics (voli-disc-bot/db/
// lootcrate_analytics.js) so site opens keep the shared stats tables accurate —
// the same daily metrics RPC, daily-users upsert, per-user stats RPC, and the
// rare-drops log. Everything is wrapped so a failure NEVER breaks an open.

const RARE_VP_AMOUNT = 100;
const RARE_CHANCE_PERCENT = 5;

export function isRareDrop(result: LootResult): boolean {
	if (result.kind === 'role' || result.kind === 'item') return true;
	if (result.kind === 'vp' && result.amount >= RARE_VP_AMOUNT) return true;
	if (result.chance > 0 && result.chance <= RARE_CHANCE_PERCENT) return true;
	return false;
}

export async function logLootcrateOpen(
	discordId: string,
	isFree: boolean,
	result: LootResult,
	username: string | null
): Promise<void> {
	const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
	const vpWon = result.kind === 'vp' ? result.amount : 0;
	const vpSpent = isFree ? 0 : 5;
	const isNothing = result.kind === 'vp' && result.amount === 0;
	const sb = db();

	try {
		await sb.rpc('increment_lootcrate_metrics', {
			p_date: today,
			p_total_opens: 1,
			p_free_opens: isFree ? 1 : 0,
			p_paid_opens: isFree ? 0 : 1,
			p_total_vp_won: vpWon,
			p_total_vp_spent: vpSpent,
			p_nothing_count: isNothing ? 1 : 0
		});

		await sb
			.from('lootcrate_daily_users')
			.upsert({ date: today, user_id: discordId, opens_count: 1 }, { onConflict: 'date,user_id', ignoreDuplicates: false });

		await sb.rpc('update_lootcrate_user_stats', {
			p_user_id: discordId,
			p_username: username,
			p_is_free: isFree,
			p_vp_won: vpWon,
			p_date: today
		});

		if (isRareDrop(result)) {
			await sb.from('lootcrate_rare_drops').insert({
				user_id: discordId,
				username,
				drop_type: result.kind,
				item_name: result.itemName,
				amount: result.amount || 0,
				chance_percent: result.chance || 0,
				was_free: isFree
			});
		}
	} catch (e) {
		console.error('[lootcrate-analytics] failed to log open:', e instanceof Error ? e.message : e);
	}
}
