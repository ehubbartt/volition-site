import { redirect, error } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { isCardTester } from '$lib/server/auth';
import { isValidRarity, DEFAULT_RARITY, toCardLayers, type Card, type CardAbility, type CardRarity } from '$lib/cards/rarity';
import type { PageServerLoad } from './$types';

interface CardRow {
	id: string;
	name: string;
	level: number | null;
	rarity: string;
	pack_id: string | null;
	abilities: CardAbility[] | null;
	flavor: string | null;
	front_url: string | null;
	back_url: string | null;
	layers: unknown;
	full_art: boolean | null;
	holo_url: string | null;
	sound_url: string | null;
	model_url: string | null;
	model_settings: Card['model_settings'];
	models: Card['models'];
}

export interface TesterPack {
	id: string;
	name: string;
	front_url: string | null;
	back_url: string | null;
	cards: Card[];
}

// Dev/test only: returns every pack with its full card list so the client can
// roll opens locally — no VP, no ownership, nothing persisted (infinite).
export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) throw redirect(303, '/');
	if (!isCardTester(locals.user)) throw error(403, 'Not allowed');

	const [packsRes, cardsRes] = await Promise.all([
		db()
			.from('vs_card_packs')
			.select('id, name, front_url, back_url, holo_regular_url, holo_reverse_url')
			.order('name', { ascending: true }),
		db()
			.from('vs_cards')
			.select('id, name, level, rarity, pack_id, abilities, flavor, front_url, back_url, layers, full_art, holo_url, sound_url, model_url, model_settings, models')
			.order('name', { ascending: true })
	]);

	if (packsRes.error) throw error(500, packsRes.error.message);
	if (cardsRes.error) throw error(500, cardsRes.error.message);

	// Per-pack holo foil overrides, applied to every card in that pack.
	const packHolo = new Map<string, { reg: string | null; rev: string | null }>();
	for (const p of packsRes.data ?? []) {
		packHolo.set(p.id, {
			reg: (p.holo_regular_url as string | null) ?? null,
			rev: (p.holo_reverse_url as string | null) ?? null
		});
	}

	const cardsByPack = new Map<string, Card[]>();
	for (const c of (cardsRes.data ?? []) as CardRow[]) {
		if (!c.pack_id) continue;
		const ph = packHolo.get(c.pack_id);
		const card: Card = {
			id: c.id,
			name: c.name,
			level: c.level,
			rarity: (isValidRarity(c.rarity) ? c.rarity : DEFAULT_RARITY) as CardRarity,
			abilities: c.abilities ?? [],
			flavor: c.flavor,
			front_url: c.front_url,
			back_url: c.back_url,
			layers: toCardLayers(c.layers),
			full_art: !!c.full_art,
			holo_url: c.holo_url,
			sound_url: c.sound_url,
			model_url: c.model_url,
			model_settings: c.model_settings ?? null,
			models: c.models ?? [],
			holo_regular_url: ph?.reg ?? null,
			holo_reverse_url: ph?.rev ?? null
		};
		const arr = cardsByPack.get(c.pack_id) ?? [];
		arr.push(card);
		cardsByPack.set(c.pack_id, arr);
	}

	const packs: TesterPack[] = (packsRes.data ?? []).map((p) => ({
		id: p.id,
		name: p.name,
		front_url: p.front_url,
		back_url: p.back_url,
		cards: cardsByPack.get(p.id) ?? []
	}));

	return { packs };
};
