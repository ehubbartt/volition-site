// SERVER-ONLY: a member's Volition TCG collection progress, for the rank-scoring
// "Volition TCG" component. Completion is measured at the DISTINCT-CARD level (own one
// copy of a card — any finish — and it counts), NOT per holo/reverse variant: owning
// every card in the released set is 100% of the category. Kept out of rankScoring.ts so
// that module stays pure (no I/O); rankCheck / the admin rank-sim fold the counts in.

import { db } from './db';
import { microCached } from './microCache';

// The obtainable set (every card in a released pack) is identity-independent and changes
// only when a pack is released/retired, so it's cached briefly and shared across members.
const RELEASED_TTL_MS = 5 * 60_000;

// Every distinct card id in a released pack — the denominator for TCG completion. Throws
// inside the cached fn on a DB error so a failure is never cached (microCache contract).
export async function getReleasedCardIds(): Promise<Set<string>> {
	return microCached('tcg:released-card-ids', RELEASED_TTL_MS, async () => {
		const { data, error } = await db()
			.from('vs_cards')
			.select('id, vs_card_packs!inner(released)')
			.eq('vs_card_packs.released', true);
		if (error) throw new Error(error.message);
		return new Set((data ?? []).map((r) => (r as { id: string }).id));
	});
}

export interface TcgProgress {
	owned: number; // distinct released cards the member owns
	total: number; // distinct released cards obtainable
}

// One member's TCG completion: distinct released cards they own over the total obtainable.
// A member with no user id (e.g. a roster member with no site account) scores 0 / total.
// Best-effort: any read failure degrades to 0 / total rather than throwing, matching the
// rest of the rank-input layer (a transient outage must not zero a real component wrongly
// — but here 0 owned is the safe floor and the check is re-run frequently).
export async function getTcgProgress(userId: string | null | undefined): Promise<TcgProgress> {
	const released = await getReleasedCardIds();
	const total = released.size;
	if (!userId || total === 0) return { owned: 0, total };

	const { data, error } = await db()
		.from('vs_user_cards')
		.select('card_id')
		.eq('user_id', userId);
	if (error || !data) return { owned: 0, total };

	// Distinct card ids the member owns that are in the released set (one row per finish,
	// so dedupe by card id first).
	const ownedIds = new Set((data as { card_id: string }[]).map((r) => r.card_id));
	let owned = 0;
	for (const id of ownedIds) if (released.has(id)) owned++;
	return { owned, total };
}
