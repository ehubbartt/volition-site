import { db } from './db';
import type { CardFinish } from '$lib/cards/finishes';

export interface CardGrant {
	card_id: string;
	finish: CardFinish;
}

// Builds a weighted card picker for one pack open. The card is chosen in two
// steps: pick a RARITY by the pack's configured weights (rarity_weights), then a
// card of that rarity uniformly. Weights are relative and only count rarities
// that actually have cards in the pool. If no positive weights are configured,
// it falls back to weighting each rarity by its card count (= uniform over all
// cards), preserving the pre-rates behavior.
export function makeRarityRoller<T extends { rarity: string }>(
	pool: T[],
	weights: Record<string, number> | null | undefined
): () => T {
	const groups = new Map<string, T[]>();
	for (const c of pool) {
		const arr = groups.get(c.rarity) ?? [];
		arr.push(c);
		groups.set(c.rarity, arr);
	}
	const rarities = [...groups.keys()];

	let w = rarities.map((r) => Math.max(0, Number(weights?.[r] ?? 0)));
	if (w.reduce((a, b) => a + b, 0) <= 0) {
		w = rarities.map((r) => groups.get(r)!.length); // uniform over all cards
	}
	const total = w.reduce((a, b) => a + b, 0);

	return () => {
		let r = Math.random() * total;
		let idx = w.length - 1;
		for (let i = 0; i < w.length; i++) {
			r -= w[i];
			if (r < 0) {
				idx = i;
				break;
			}
		}
		const g = groups.get(rarities[idx])!;
		return g[Math.floor(Math.random() * g.length)];
	};
}

// Grants rolled cards to a user's collection (vs_user_cards), incrementing
// quantity for cards they already own. Each (card, finish) pair is a SEPARATE
// inventory row — a Normal copy and a Holo copy of the same card stack apart.
// Site-owned tables (unlike VP, which lives in the bot's players table — see
// playerStats.ts). Used by the /gamba open flow after VP has been spent.
export async function grantCards(
	userId: string,
	grants: CardGrant[]
): Promise<{ ok: true } | { ok: false; error: string }> {
	if (grants.length === 0) return { ok: true };
	const sb = db();

	// Tally how many of each distinct (card, finish) were rolled.
	const counts = new Map<string, number>();
	for (const g of grants) {
		const key = `${g.card_id}|${g.finish}`;
		counts.set(key, (counts.get(key) ?? 0) + 1);
	}
	const keys = [...counts.keys()];
	const cardIds = [...new Set(grants.map((g) => g.card_id))];

	// Read current rows for the affected cards so we increment rather than
	// overwrite, and preserve first_acquired_at for entries already owned.
	const { data: existing, error: exErr } = await sb
		.from('vs_user_cards')
		.select('card_id, finish, quantity, first_acquired_at')
		.eq('user_id', userId)
		.in('card_id', cardIds);
	if (exErr) return { ok: false, error: exErr.message };

	const have = new Map<string, number>();
	const firstAt = new Map<string, string>();
	for (const row of existing ?? []) {
		const key = `${row.card_id}|${row.finish}`;
		have.set(key, (row.quantity as number) ?? 0);
		if (row.first_acquired_at) firstAt.set(key, row.first_acquired_at as string);
	}

	const now = new Date().toISOString();
	const rows = keys.map((key) => {
		const [card_id, finish] = key.split('|');
		return {
			user_id: userId,
			card_id,
			finish,
			quantity: (have.get(key) ?? 0) + (counts.get(key) ?? 0),
			first_acquired_at: firstAt.get(key) ?? now,
			updated_at: now
		};
	});

	const { error: upErr } = await sb
		.from('vs_user_cards')
		.upsert(rows, { onConflict: 'user_id,card_id,finish' });
	if (upErr) return { ok: false, error: upErr.message };
	return { ok: true };
}
