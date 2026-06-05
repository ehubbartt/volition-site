import { db } from './db';

// Grants rolled cards to a user's collection (vs_user_cards), incrementing
// quantity for cards they already own. Site-owned tables (unlike VP, which lives
// in the bot's players table — see playerStats.ts). Used by the /gamba open flow
// after VP has been spent.
export async function grantCards(
	userId: string,
	cardIds: string[]
): Promise<{ ok: true } | { ok: false; error: string }> {
	if (cardIds.length === 0) return { ok: true };
	const sb = db();

	// Tally how many of each distinct card were rolled.
	const counts = new Map<string, number>();
	for (const id of cardIds) counts.set(id, (counts.get(id) ?? 0) + 1);
	const ids = [...counts.keys()];

	// Read current quantities (and acquisition times) so we increment rather than
	// overwrite, and preserve first_acquired_at on cards already owned.
	const { data: existing, error: exErr } = await sb
		.from('vs_user_cards')
		.select('card_id, quantity, first_acquired_at')
		.eq('user_id', userId)
		.in('card_id', ids);
	if (exErr) return { ok: false, error: exErr.message };

	const have = new Map<string, number>();
	const firstAt = new Map<string, string>();
	for (const row of existing ?? []) {
		have.set(row.card_id as string, (row.quantity as number) ?? 0);
		if (row.first_acquired_at) firstAt.set(row.card_id as string, row.first_acquired_at as string);
	}

	const now = new Date().toISOString();
	const rows = ids.map((card_id) => ({
		user_id: userId,
		card_id,
		quantity: (have.get(card_id) ?? 0) + (counts.get(card_id) ?? 0),
		first_acquired_at: firstAt.get(card_id) ?? now,
		updated_at: now
	}));

	const { error: upErr } = await sb
		.from('vs_user_cards')
		.upsert(rows, { onConflict: 'user_id,card_id' });
	if (upErr) return { ok: false, error: upErr.message };
	return { ok: true };
}
