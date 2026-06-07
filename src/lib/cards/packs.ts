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
