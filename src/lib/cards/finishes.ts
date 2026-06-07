// Client-safe card finishes (holo variants). Not secret. When a pack is opened
// each pulled card rolls a finish, which is tracked SEPARATELY in the collection
// (vs_user_cards.finish) — a Normal Olm and a Holo·Prism Olm are distinct items.
//
// holo/sheen/pattern map to the PackOpener holo shader (the four holo looks the
// opener was tuned around); weight = relative roll odds (tune these to change how
// often each finish appears). These finish odds are independent of which card is
// rolled.

export type CardFinish = 'normal' | 'stripe' | 'sparkle' | 'wave' | 'prism';

export interface FinishMeta {
	key: CardFinish;
	label: string; // short label for badges
	holo: number; // shader rainbow strength (0 = no holo)
	sheen: number; // shader moving glare
	pattern: number; // shader holo pattern index (-1 = none)
	weight: number; // relative roll weight (higher = more common)
}

// Order = display order (rarest last). Tune `weight` to change pull odds.
export const FINISHES: FinishMeta[] = [
	{ key: 'normal', label: 'Normal', holo: 0, sheen: 0, pattern: -1, weight: 80 },
	{ key: 'stripe', label: 'Holo · Stripe', holo: 0.03, sheen: 0.005, pattern: 0, weight: 10 },
	{ key: 'sparkle', label: 'Holo · Sparkle', holo: 0.04, sheen: 0.005, pattern: 1, weight: 6 },
	{ key: 'wave', label: 'Holo · Wave', holo: 0.014, sheen: 0.006, pattern: 2, weight: 3 },
	{ key: 'prism', label: 'Holo · Prism', holo: 0.02, sheen: 0.008, pattern: 3, weight: 1 }
];

export const FINISH_BY_KEY: Record<CardFinish, FinishMeta> = Object.fromEntries(
	FINISHES.map((f) => [f.key, f])
) as Record<CardFinish, FinishMeta>;

// The holo finishes only (everything except Normal) — used as the opener's
// look-comparison cycle when no real finish is supplied (e.g. the pack tester).
export const HOLO_FINISHES = FINISHES.filter((f) => f.key !== 'normal');

export function isValidFinish(value: unknown): value is CardFinish {
	return typeof value === 'string' && value in FINISH_BY_KEY;
}

// Weighted random finish for a pulled card.
export function rollFinish(): CardFinish {
	const total = FINISHES.reduce((sum, f) => sum + f.weight, 0);
	let r = Math.random() * total;
	for (const f of FINISHES) {
		r -= f.weight;
		if (r < 0) return f.key;
	}
	return 'normal';
}
