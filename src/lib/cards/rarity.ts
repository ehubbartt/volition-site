// Client-safe card metadata. Card content is NOT secret (unlike bingo tiles),
// so this lives outside src/lib/server and can be imported anywhere.

// OSRS metal-tier progression (bronze → SR), plus a separate Elemental tier used
// for event cards (it's a valid rarity but isn't part of the normal pull ladder).
export type CardRarity =
	| 'bronze'
	| 'iron'
	| 'steel'
	| 'mithril'
	| 'adamant'
	| 'rune'
	| 'dragon'
	| 'sr'
	| 'elemental';

// Fallback for unknown/legacy rarity values (the lowest tier).
export const DEFAULT_RARITY: CardRarity = 'bronze';

// Shared Volition card back, used when a card has no custom back art.
export const DEFAULT_CARD_BACK = '/cards/card-back.png';

export interface CardAbility {
	name: string;
	description: string;
}

export interface Card {
	id: string;
	name: string;
	level: number | null;
	rarity: CardRarity;
	abilities: CardAbility[];
	flavor: string | null;
	front_url: string | null;
	back_url: string | null;
}

// A card the user owns, with how many copies. `finish` is the holo variant —
// the same card in a different finish is a separate collection entry.
export interface UserCard extends Card {
	quantity: number;
	finish: import('./finishes').CardFinish;
}

export interface RarityMeta {
	key: CardRarity;
	label: string;
	color: string;
}

// Ascending tier order (used for ordering anywhere that needs it). Elemental is
// last as the special event tier.
export const RARITIES: RarityMeta[] = [
	{ key: 'bronze', label: 'Bronze', color: '#b87333' },
	{ key: 'iron', label: 'Iron', color: '#73797f' },
	{ key: 'steel', label: 'Steel', color: '#aeb7c2' },
	{ key: 'mithril', label: 'Mithril', color: '#4f6fe0' },
	{ key: 'adamant', label: 'Adamant', color: '#3fb074' },
	{ key: 'rune', label: 'Rune', color: '#3fc8d6' },
	{ key: 'dragon', label: 'Dragon', color: '#e34a2c' },
	{ key: 'sr', label: 'SR', color: '#ffc63a' },
	{ key: 'elemental', label: 'Elemental', color: '#b06bff' }
];

export const RARITY_BY_KEY: Record<CardRarity, RarityMeta> = Object.fromEntries(
	RARITIES.map((r) => [r.key, r])
) as Record<CardRarity, RarityMeta>;

export function isValidRarity(value: unknown): value is CardRarity {
	return typeof value === 'string' && value in RARITY_BY_KEY;
}
