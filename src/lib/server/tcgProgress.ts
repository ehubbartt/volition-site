// SERVER-ONLY: a member's Volition TCG collection progress, for the rank-scoring
// "Volition TCG" component. Completion is measured at the VARIANT level — the same slots
// the Collection tab shows (finishVariants.ts): each finish a card can roll (Holo /
// Reverse / Normal) is its own slot, so owning every obtainable variant = 100%. Cards from
// ELEMENTAL packs (event-gift packs, not freely obtainable) are excluded entirely. Kept
// out of rankScoring.ts so that module stays pure (no I/O); rankCheck / the admin rank-sim
// fold the counts in.

import { db } from './db';
import { microCached } from './microCache';
import { possibleFinishes, type FinishCard } from '$lib/cards/finishVariants';
import { isValidRarity, DEFAULT_RARITY } from '$lib/cards/rarity';
import { isValidFinish, type CardFinish } from '$lib/cards/finishes';

// The obtainable catalog (every card in a released, non-elemental pack) is
// identity-independent and changes only when a pack is released/retired/flagged, so it's
// cached briefly and shared across members.
const CATALOG_TTL_MS = 5 * 60_000;

interface CatalogCard {
	id: string;
	rarity: string; // validated
	isSr: boolean; // secret rare — a single mystery slot until any finish is owned
	finishes: CardFinish[]; // the variant slots this card can roll (possibleFinishes)
}

interface TcgCatalog {
	cards: CatalogCard[];
	ids: Set<string>;
}

// Every card in a released, non-elemental pack, with the finish-variants it can roll —
// the shape the completion count is built from. Throws inside the cached fn on a DB error
// so a failure is never cached (microCache contract).
export async function getTcgCatalog(): Promise<TcgCatalog> {
	return microCached('tcg:catalog', CATALOG_TTL_MS, async () => {
		const { data, error } = await db()
			.from('vs_cards')
			.select('id, rarity, full_art, vs_card_packs!inner(released, elemental, slot_finishes, slot_weights, rarity_weights)')
			.eq('vs_card_packs.released', true)
			.eq('vs_card_packs.elemental', false);
		if (error) throw new Error(error.message);

		const cards: CatalogCard[] = (data ?? []).map((row) => {
			const c = row as unknown as {
				id: string;
				rarity: string;
				full_art: boolean | null;
				vs_card_packs: FinishCard['pack'];
			};
			const rarity = isValidRarity(c.rarity) ? c.rarity : DEFAULT_RARITY;
			return {
				id: c.id,
				rarity,
				isSr: rarity === 'sr',
				finishes: possibleFinishes({ full_art: c.full_art, rarity: c.rarity, pack: c.vs_card_packs })
			};
		});
		return { cards, ids: new Set(cards.map((c) => c.id)) };
	});
}

export interface TcgProgress {
	owned: number; // variant slots owned across the obtainable catalog
	total: number; // total obtainable variant slots
}

// One member's TCG completion, counted the same way the Collection tab does: owned finish
// variants over total obtainable variants, excluding elemental packs. A secret rare shows
// as a single slot until any finish of it is owned (mirrors cardProfile.ts). A member with
// no site account scores 0 / total. Best-effort: a read failure degrades to 0 / total.
export async function getTcgProgress(userId: string | null | undefined): Promise<TcgProgress> {
	const { cards, ids } = await getTcgCatalog();

	// Group the member's owned finishes by card id, restricted to the obtainable catalog.
	const ownedByCard = new Map<string, Set<CardFinish>>();
	if (userId) {
		const { data, error } = await db()
			.from('vs_user_cards')
			.select('card_id, finish')
			.eq('user_id', userId);
		if (!error && data) {
			for (const r of data as { card_id: string; finish: string }[]) {
				if (!ids.has(r.card_id)) continue;
				const finish = (isValidFinish(r.finish) ? r.finish : 'normal') as CardFinish;
				(ownedByCard.get(r.card_id) ?? ownedByCard.set(r.card_id, new Set()).get(r.card_id)!).add(finish);
			}
		}
	}

	let owned = 0;
	let total = 0;
	for (const card of cards) {
		const has = ownedByCard.get(card.id);
		// Undiscovered secret rare: one mystery slot, nothing owned (matches the grid).
		if (card.isSr && (!has || has.size === 0)) {
			total += 1;
			continue;
		}
		// Slots = the finishes this card can roll, plus any owned finish the odds no longer
		// offer (so an owned copy is never hidden). Every owned finish is a slot → owned count
		// is exactly how many finishes the member holds.
		const slots = new Set<CardFinish>(card.finishes);
		if (has) for (const f of has) slots.add(f);
		total += slots.size;
		owned += has ? has.size : 0;
	}
	return { owned, total };
}
