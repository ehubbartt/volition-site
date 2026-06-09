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

// An extra image stacked above the front face for the 3D depth effect.
export interface CardLayer {
	url: string;
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
	// Optional stacked depth layers (bottom→top), rendered above the front in 3D.
	layers?: CardLayer[];
	// Full-art card: art covers the whole card, so holo/reverse-holo never apply.
	full_art?: boolean;
	// Optional per-card holo foil texture. For full-art cards only — when set, the
	// foil covers the whole card (on the base front, below any depth layers).
	holo_url?: string | null;
	// Optional sound that plays when the card is revealed in the pack opener.
	sound_url?: string | null;
	// Effective per-pack holo foil textures for the masked finishes (regular /
	// reverse). When set on the card's pack, holo cards from that pack use these
	// instead of the shared static star/ripple foils. Resolved by the loaders.
	holo_regular_url?: string | null;
	holo_reverse_url?: string | null;
	// Undiscovered placeholder (e.g. an un-pulled secret rare): a spot is shown but
	// the card's look is redacted server-side. Renderers show a mystery card.
	hidden?: boolean;
}

// A card the user owns, with how many copies. `finish` is the holo variant —
// the same card in a different finish is a separate collection entry.
export interface UserCard extends Card {
	quantity: number;
	finish: import('./finishes').CardFinish;
}

// A redacted placeholder for an undiscovered card. Keeps the rarity + a stable id
// (for grid layout / {#each} keys) but reveals nothing about the card's look — used
// to show "mystery" spots for secret rares until they're pulled.
export function hiddenCard(id: string, rarity: CardRarity): Card {
	return {
		id,
		name: '???',
		level: null,
		rarity,
		abilities: [],
		flavor: null,
		front_url: null,
		back_url: null,
		layers: [],
		full_art: false,
		holo_url: null,
		sound_url: null,
		holo_regular_url: null,
		holo_reverse_url: null,
		hidden: true
	};
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

// "Rare" = dragon rarity and up (dragon, sr, and the elemental event tier) —
// the threshold for the /gamba recent-rares feed. Compared by position in
// RARITIES so reordering/adding tiers stays consistent.
export const RARE_MIN_RARITY: CardRarity = 'dragon';
const RARE_MIN_INDEX = RARITIES.findIndex((r) => r.key === RARE_MIN_RARITY);

export function isRareRarity(value: unknown): boolean {
	if (typeof value !== 'string') return false;
	const i = RARITIES.findIndex((r) => r.key === value);
	return i >= 0 && i >= RARE_MIN_INDEX;
}

// The rarity keys that count as "rare" (dragon+), for querying the rare-pull feed
// (vs_pack_open_cards) with a simple `.in('rarity', RARE_RARITIES)`.
export const RARE_RARITIES: CardRarity[] = RARITIES.filter((_, i) => i >= RARE_MIN_INDEX).map(
	(r) => r.key
);

// Normalises a stored `vs_cards.layers` jsonb value (an array of {path, url}) to
// the client-safe CardLayer[] (urls only), dropping anything without a url.
export function toCardLayers(raw: unknown): CardLayer[] {
	if (!Array.isArray(raw)) return [];
	const out: CardLayer[] = [];
	for (const l of raw) {
		const url = (l as { url?: unknown })?.url;
		if (typeof url === 'string' && url) out.push({ url });
	}
	return out;
}
