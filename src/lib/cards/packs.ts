// Client-safe card-pack metadata. Like cards, pack content is not secret.

export const DEFAULT_PACK_FRONT = '/packs/pack-front.png';
export const DEFAULT_PACK_BACK = '/packs/pack-back.png';

export interface CardPack {
	id: string;
	name: string;
	description: string | null;
	cost_vp: number;
	front_url: string | null;
	back_url: string | null;
}

// A pack the user owns, with how many unopened copies.
export interface UserPack extends CardPack {
	quantity: number;
}

// Apply a pack's percent discount to a price. Clamped 0–100, rounded to a whole
// number. Used BOTH server-side (the actual charge) and client-side (display), so the
// price shown always matches what's deducted. 0 / no discount returns the price as-is.
export function discountedPrice(
	price: number | null | undefined,
	pct: number | null | undefined
): number {
	const p = Number(price) || 0;
	const d = Math.min(100, Math.max(0, Number(pct) || 0));
	if (d <= 0) return p;
	return Math.round(p * (1 - d / 100));
}
