import type { CardFinish } from './finishes';

// Which finish-variants a card can actually roll, and whether a given slot can produce a
// rarity — the single source of truth shared by the collection grid (cardProfile.ts) and
// the Volition TCG rank component (server/tcgProgress.ts) so the two never diverge on what
// counts as a "variant". Pure: no I/O, no DB shapes beyond the small inputs below.

export interface PackFinishConfig {
	slot_finishes: { holo?: number | null; reverse?: number | null }[] | null;
	slot_weights: Record<string, number>[] | null;
	rarity_weights: Record<string, number> | null;
}

export interface FinishCard {
	full_art: boolean | null;
	rarity: string;
	pack: PackFinishConfig | null;
}

const hasPositive = (w: Record<string, number> | null | undefined): boolean =>
	!!w && Object.values(w).some((v) => Number(v) > 0);

// Can a slot ever roll a given rarity? Mirrors the roller's fallback chain
// (gamba.ts makeSlotRoller): a slot's own weights, else the pack's rarity_weights,
// else uniform over every rarity the pack actually has cards in.
function slotCanRollRarity(pack: PackFinishConfig, slotIndex: number, rarity: string): boolean {
	const sw = Array.isArray(pack.slot_weights) ? pack.slot_weights[slotIndex] : null;
	if (hasPositive(sw)) return Number(sw![rarity] ?? 0) > 0;
	if (hasPositive(pack.rarity_weights)) return Number(pack.rarity_weights![rarity] ?? 0) > 0;
	return true; // uniform over present rarities — the card's own rarity is present
}

// Which finishes a card can have, ordered Holo → Reverse Holo → Normal. Normal is always
// possible. Holo/Reverse only if the card ISN'T full-art (the foil masks never apply to
// full-art) AND its pack can produce that finish FOR THIS card's rarity: with no
// slot_finishes the legacy positional rule lets any non-full-art card land Holo/Reverse;
// otherwise some slot must both offer the finish (>0%) AND be able to roll the card's rarity.
export function possibleFinishes(card: FinishCard): CardFinish[] {
	if (card.full_art || !card.pack) return ['normal'];
	const pack = card.pack;
	const sf = Array.isArray(pack.slot_finishes) ? pack.slot_finishes : [];
	const legacy = sf.length === 0;
	const offers = (kind: 'holo' | 'reverse'): boolean => {
		if (legacy) return true;
		return sf.some(
			(s, i) => ((kind === 'holo' ? s?.holo : s?.reverse) ?? 0) > 0 && slotCanRollRarity(pack, i, card.rarity)
		);
	};
	const out: CardFinish[] = [];
	if (offers('holo')) out.push('holo');
	if (offers('reverse')) out.push('reverse');
	out.push('normal');
	return out;
}
