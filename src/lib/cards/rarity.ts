// Client-safe card metadata. Card content is NOT secret (unlike bingo tiles),
// so this lives outside src/lib/server and can be imported anywhere.

import { isLayerEffect, type LayerEffect } from './layerEffects';

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

// An extra image stacked above the front face for the 3D depth effect. May carry
// an optional animation `effect` (see src/lib/cards/layerEffects.ts) that the 3D
// renderers play on that layer.
export interface CardLayer {
	url: string;
	effect?: LayerEffect | null;
}

// Which local axis of the model is its "front" (the nose). Used to orient the model
// for `faceCamera` (point front at the viewer) and `wander` (face the direction of
// travel) regardless of how the .glb was exported. Default '+z'.
export type ModelFrontAxis = '+x' | '-x' | '+y' | '-y' | '+z' | '-z';

// Placement / behaviour knobs for one card 3D model (edited in the visual builder).
// All angles are DEGREES; positions are card units. Lives here (client-safe, no three
// import) so it can flow through the Card type; cardModel.ts re-exports it.
export interface CardModelSettings {
	scale?: number; // multiplier over the auto-fit scale (default 1)
	offsetX?: number;
	offsetY?: number;
	offsetZ?: number; // depth (default = hover/embed z)
	rotX?: number;
	rotY?: number;
	rotZ?: number;
	spin?: number; // idle auto-spin rad/s about Y (0 = tilt-only)
	animate?: boolean; // play the embedded GLB clip(s) (default true)
	clip?: boolean; // embed in the card face + clip anything behind it
	faceCamera?: boolean; // billboard: front axis points at the camera (e.g. an eye)
	wander?: boolean; // roam within the card bounds, facing the direction of travel
	wanderSpeed?: number; // wander movement speed, card units/sec (default ~0.5)
	frontAxis?: ModelFrontAxis; // which local axis is the model's front (default '+z')
}

// One placed model on a card. `path` is the storage path (server-side cleanup); the
// renderers only need `url` + `settings`.
export interface CardModelEntry {
	path?: string | null;
	url: string;
	settings?: CardModelSettings | null;
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
	// LEGACY single 3D model (0038) — superseded by `models` (0039); kept as a fallback.
	model_url?: string | null;
	model_settings?: CardModelSettings | null;
	// Optional Blender .glb models rendered on the card in 3D, each placed independently
	// via the builder. Source of truth for the renderers (falls back to the single one).
	models?: CardModelEntry[];
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
		model_url: null,
		model_settings: null,
		models: [],
		holo_regular_url: null,
		holo_reverse_url: null,
		hidden: true
	};
}

// The card's 3D models for the renderers: prefer the `models` array, else fall back to
// the legacy single model. Client-safe (no three import).
export function toCardModels(card: {
	models?: CardModelEntry[] | null;
	model_url?: string | null;
	model_settings?: CardModelSettings | null;
}): CardModelEntry[] {
	const list = Array.isArray(card.models) ? card.models.filter((m) => m && m.url) : [];
	if (list.length) return list;
	return card.model_url ? [{ url: card.model_url, settings: card.model_settings ?? {} }] : [];
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

// Normalises a stored `vs_cards.layers` jsonb value (an array of {path, url, effect})
// to the client-safe CardLayer[] (url + optional effect), dropping anything without
// a url and invalid effect keys.
export function toCardLayers(raw: unknown): CardLayer[] {
	if (!Array.isArray(raw)) return [];
	const out: CardLayer[] = [];
	for (const l of raw) {
		const url = (l as { url?: unknown })?.url;
		if (typeof url === 'string' && url) {
			const effect = (l as { effect?: unknown })?.effect;
			out.push({ url, effect: isLayerEffect(effect) ? effect : null });
		}
	}
	return out;
}
