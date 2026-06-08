import { redirect, fail } from '@sveltejs/kit';
import { z } from 'zod';
import { db } from '$lib/server/db';
import { isValidClan, CLAN_OPTIONS } from '$lib/clans';
import { isValidAccountType, ACCOUNT_TYPES } from '$lib/accountTypes';
import { getPlayerVp, getWalletItems } from '$lib/server/playerStats';
import { isValidRarity, DEFAULT_RARITY, toCardLayers, type UserCard, type CardAbility, type CardRarity } from '$lib/cards/rarity';
import { isValidFinish, type CardFinish } from '$lib/cards/finishes';
import type { UserPack } from '$lib/cards/packs';
import type { Actions, PageServerLoad } from './$types';

interface UserCardRow {
	quantity: number;
	finish: string;
	vs_cards: {
		id: string;
		name: string;
		level: number | null;
		rarity: string;
		abilities: CardAbility[] | null;
		flavor: string | null;
		front_url: string | null;
		back_url: string | null;
		layers: unknown;
		full_art: boolean | null;
	} | null;
}

interface UserPackRow {
	quantity: number;
	vs_card_packs: {
		id: string;
		name: string;
		description: string | null;
		cost_vp: number;
		front_url: string | null;
		back_url: string | null;
	} | null;
}

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) throw redirect(303, '/');

	const [vp_balance, wallet, inventoryRes, packsRes] = await Promise.all([
		getPlayerVp(locals.user.discord_id, locals.user.rsn),
		getWalletItems(locals.user.discord_id),
		db()
			.from('vs_user_cards')
			.select('quantity, finish, vs_cards(id, name, level, rarity, abilities, flavor, front_url, back_url, layers, full_art)')
			.eq('user_id', locals.user.id)
			.order('first_acquired_at', { ascending: false }),
		db()
			.from('vs_user_packs')
			.select('quantity, vs_card_packs(id, name, description, cost_vp, front_url, back_url)')
			.eq('user_id', locals.user.id)
			.order('updated_at', { ascending: false })
	]);

	const collection: UserCard[] = ((inventoryRes.data ?? []) as unknown as UserCardRow[])
		.filter((row) => row.vs_cards)
		.map((row) => {
			const c = row.vs_cards!;
			return {
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
				quantity: row.quantity,
				finish: (isValidFinish(row.finish) ? row.finish : 'normal') as CardFinish
			};
		});

	const packs: UserPack[] = ((packsRes.data ?? []) as unknown as UserPackRow[])
		.filter((row) => row.vs_card_packs)
		.map((row) => {
			const p = row.vs_card_packs!;
			return {
				id: p.id,
				name: p.name,
				description: p.description,
				cost_vp: p.cost_vp,
				front_url: p.front_url,
				back_url: p.back_url,
				quantity: row.quantity
			};
		});

	return {
		user: locals.user,
		clanOptions: CLAN_OPTIONS,
		accountTypes: ACCOUNT_TYPES,
		vp_balance,
		wallet,
		collection,
		packs
	};
};

const RSN_REGEX = /^[A-Za-z0-9 _-]{1,12}$/;

const profileSchema = z.object({
	rsn: z
		.string()
		.trim()
		.regex(RSN_REGEX, 'RSN must be 1-12 chars (letters, numbers, space, _ or -)'),
	clan_allegiance: z.string().refine(isValidClan, 'Pick a clan'),
	account_type: z.string().refine(isValidAccountType, 'Pick your account type')
});

export const actions: Actions = {
	default: async ({ request, locals }) => {
		if (!locals.user) throw redirect(303, '/');

		const form = await request.formData();
		const parsed = profileSchema.safeParse({
			rsn: form.get('rsn'),
			clan_allegiance: form.get('clan_allegiance'),
			account_type: form.get('account_type')
		});

		if (!parsed.success) {
			return fail(400, {
				error: parsed.error.issues[0]?.message ?? 'Invalid input'
			});
		}

		const { rsn, clan_allegiance, account_type } = parsed.data;
		const supabase = db();

		const { data: collision } = await supabase
			.from('vs_users')
			.select('id')
			.ilike('rsn', rsn)
			.neq('id', locals.user.id)
			.maybeSingle();

		if (collision) {
			return fail(409, { error: 'That RSN is already registered to another account' });
		}

		const { error } = await supabase
			.from('vs_users')
			.update({ rsn, clan_allegiance, account_type })
			.eq('id', locals.user.id);

		if (error) return fail(500, { error: error.message });

		return { success: true };
	}
};
