// Client-safe card finishes (holo variants). Not secret. When a pack is opened
// each pulled card gets a finish, which is tracked SEPARATELY in the collection
// (vs_user_cards.finish) — a Normal Olm and a Holo Olm are distinct items.
//
// A holo finish is a foil shine overlaid onto the card front, masked to a region:
//  - `regular` (Holo)         — foil over the main art window     (mask-regular.png)
//  - `reverse` (Reverse Holo) — foil over everything BUT the art  (mask-reverse.png)
// The foil itself is one of the holo textures in static/holo (star / ripple). The
// region masks use the ALPHA channel (opaque = apply the foil there). Rendered by
// the holo shader in $lib/cards/holo.ts (used by PackOpener + CardInspector3D).

export type CardFinish = 'normal' | 'holo' | 'reverse';
export type HoloPlacement = 'regular' | 'reverse';
export type HoloTexture = 'star' | 'ripple';

export interface FinishMeta {
	key: CardFinish;
	label: string; // short label for badges
	placement: HoloPlacement | null; // which region mask (null = no holo / Normal)
	texture: HoloTexture | null; // which foil overlay (null = none)
	strength: number; // foil intensity (0 = none)
	weight: number; // legacy random-roll weight (kept; holos are positional for now)
}

export const FINISHES: FinishMeta[] = [
	{ key: 'normal', label: 'Normal', placement: null, texture: null, strength: 0, weight: 80 },
	{ key: 'holo', label: 'Holo', placement: 'regular', texture: 'star', strength: 1, weight: 14 },
	{
		key: 'reverse',
		label: 'Reverse Holo',
		placement: 'reverse',
		texture: 'ripple',
		strength: 1,
		weight: 6
	}
];

export const FINISH_BY_KEY: Record<CardFinish, FinishMeta> = Object.fromEntries(
	FINISHES.map((f) => [f.key, f])
) as Record<CardFinish, FinishMeta>;

// The holo finishes only (everything except Normal).
export const HOLO_FINISHES = FINISHES.filter((f) => f.placement !== null);

// Foil overlay (colour) + region mask (alpha) assets, served from static/holo.
export const HOLO_TEXTURE_URL: Record<HoloTexture, string> = {
	star: '/holo/star-holo.jpg',
	ripple: '/holo/ripple-holo.jpg'
};
export const HOLO_MASK_URL: Record<HoloPlacement, string> = {
	regular: '/holo/mask-regular.png',
	reverse: '/holo/mask-reverse.png'
};

// Border-frame region mask (alpha = the card's outer frame, transparent centre).
// Used for "border reverse holo" full-art cards (vs_cards.holo_border) — the foil
// shows only on the frame, leaving the full-art centre clean. See the holo shader.
export const HOLO_BORDER_MASK_URL = '/holo/mask-border.png';

export function isValidFinish(value: unknown): value is CardFinish {
	return typeof value === 'string' && value in FINISH_BY_KEY;
}

// Weighted random finish. Currently UNUSED by the open flow (the last card is a
// guaranteed Holo and the second-to-last a guaranteed Reverse Holo — see
// gamba/+page.server.ts), but kept for when finishes go back to being rolled.
export function rollFinish(): CardFinish {
	const total = FINISHES.reduce((sum, f) => sum + f.weight, 0);
	let r = Math.random() * total;
	for (const f of FINISHES) {
		r -= f.weight;
		if (r < 0) return f.key;
	}
	return 'normal';
}
