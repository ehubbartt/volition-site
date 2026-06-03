// Client-safe card metadata. Card content is NOT secret (unlike bingo tiles),
// so this lives outside src/lib/server and can be imported anywhere.

export type CardRarity = 'common' | 'uncommon' | 'rare' | 'epic' | 'legendary';

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

// A card the user owns, with how many copies.
export interface UserCard extends Card {
	quantity: number;
}

export interface RarityMeta {
	key: CardRarity;
	label: string;
	color: string;
}

export const RARITIES: RarityMeta[] = [
	{ key: 'common', label: 'Common', color: '#9a8e7a' },
	{ key: 'uncommon', label: 'Uncommon', color: '#5fc35f' },
	{ key: 'rare', label: 'Rare', color: '#3aa6ff' },
	{ key: 'epic', label: 'Epic', color: '#b06bff' },
	{ key: 'legendary', label: 'Legendary', color: '#ff981f' }
];

export const RARITY_BY_KEY: Record<CardRarity, RarityMeta> = Object.fromEntries(
	RARITIES.map((r) => [r.key, r])
) as Record<CardRarity, RarityMeta>;

export function isValidRarity(value: unknown): value is CardRarity {
	return typeof value === 'string' && value in RARITY_BY_KEY;
}
