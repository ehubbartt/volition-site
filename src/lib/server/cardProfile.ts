import { db } from './db';
import { getPlayerVp, getWalletItems, type WalletItem } from './playerStats';
import {
	isValidRarity,
	DEFAULT_RARITY,
	RARITIES,
	toCardLayers,
	hiddenCard,
	type UserCard,
	type CardAbility,
	type CardRarity
} from '$lib/cards/rarity';
import { isValidFinish, type CardFinish } from '$lib/cards/finishes';
import type { UserPack } from '$lib/cards/packs';

// Shared builder for a player's card-game profile (collection, owned packs, VP,
// wallet, and personal stats). Used by both /me (own profile) and /u/[id] (public
// profile) so the two stay identical. The card catalog comparison is per-player
// state only — no server-only redaction needed (card content isn't secret).

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
		holo_url: string | null;
		sound_url: string | null;
		vs_card_packs: { holo_regular_url: string | null; holo_reverse_url: string | null } | null;
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

interface CatalogRow {
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
	holo_url: string | null;
	sound_url: string | null;
	vs_card_packs: { holo_regular_url: string | null; holo_reverse_url: string | null } | null;
}

// Collection entries carry an `owned` flag — unowned catalog cards show greyed out.
export type CollectionCard = UserCard & { owned: boolean };

export interface CardProfile {
	vp_balance: number;
	wallet: WalletItem[];
	collection: CollectionCard[];
	collectionOwned: number;
	collectionTotal: number;
	packs: UserPack[];
	stats: {
		packsOpened: number;
		vpSpent: number;
		cardsPulled: number;
		cardsOwned: number;
	};
	crateStats: {
		totalOpens: number;
		freeOpens: number;
		paidOpens: number;
		vpWon: number;
		vpSpent: number;
		biggestWin: number;
		lastOpen: string | null;
	};
}

export async function loadCardProfile(user: {
	id: string;
	discord_id: string;
	rsn: string | null;
}): Promise<CardProfile> {
	const [vp_balance, wallet, inventoryRes, packsRes, catalogRes, opensRes, crateRes] = await Promise.all([
		getPlayerVp(user.discord_id, user.rsn),
		getWalletItems(user.discord_id),
		db()
			.from('vs_user_cards')
			.select('quantity, finish, vs_cards(id, name, level, rarity, abilities, flavor, front_url, back_url, layers, full_art, holo_url, sound_url, vs_card_packs(holo_regular_url, holo_reverse_url))')
			.eq('user_id', user.id)
			.order('first_acquired_at', { ascending: false }),
		db()
			.from('vs_user_packs')
			.select('quantity, vs_card_packs(id, name, description, cost_vp, front_url, back_url)')
			.eq('user_id', user.id)
			.order('updated_at', { ascending: false }),
		// Full set of obtainable cards (from released packs), to show what's missing.
		db()
			.from('vs_cards')
			.select('id, name, level, rarity, abilities, flavor, front_url, back_url, layers, full_art, holo_url, sound_url, vs_card_packs!inner(released, holo_regular_url, holo_reverse_url)')
			.eq('vs_card_packs.released', true),
		db().from('vs_pack_opens').select('cost_vp, card_count').eq('user_id', user.id),
		// Gamba-crate lifetime stats from the bot's aggregate table (keyed by discord_id).
		db()
			.from('lootcrate_user_stats')
			.select('total_opens, free_opens, paid_opens, total_vp_won, total_vp_spent, biggest_win, last_open_date')
			.eq('user_id', user.discord_id)
			.maybeSingle()
	]);

	// Owned entries — one per (card, finish).
	const owned: CollectionCard[] = ((inventoryRes.data ?? []) as unknown as UserCardRow[])
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
				holo_url: c.holo_url,
				sound_url: c.sound_url,
				holo_regular_url: c.vs_card_packs?.holo_regular_url ?? null,
				holo_reverse_url: c.vs_card_packs?.holo_reverse_url ?? null,
				quantity: row.quantity,
				finish: (isValidFinish(row.finish) ? row.finish : 'normal') as CardFinish,
				owned: true
			};
		});

	// Placeholders for catalog cards the player doesn't own. Cards below SR show a
	// greyed-out preview of the real art. SR ("secret rare") cards instead get a
	// REDACTED mystery spot — the slot is shown (and counted) but its look is
	// stripped server-side so it stays a surprise until pulled. Once owned, an SR
	// shows normally (it's in `owned` above).
	const ownedIds = new Set(owned.map((c) => c.id));
	const unowned: CollectionCard[] = ((catalogRes.data ?? []) as unknown as CatalogRow[])
		.filter((c) => !ownedIds.has(c.id))
		.map((c) => {
			const rarity = (isValidRarity(c.rarity) ? c.rarity : DEFAULT_RARITY) as CardRarity;
			if (rarity === 'sr') {
				return {
					...hiddenCard(c.id, rarity),
					quantity: 0,
					finish: 'normal' as CardFinish,
					owned: false
				};
			}
			return {
				id: c.id,
				name: c.name,
				level: c.level,
				rarity,
				abilities: c.abilities ?? [],
				flavor: c.flavor,
				front_url: c.front_url,
				back_url: c.back_url,
				layers: toCardLayers(c.layers),
				full_art: !!c.full_art,
				holo_url: c.holo_url,
				sound_url: c.sound_url,
				holo_regular_url: c.vs_card_packs?.holo_regular_url ?? null,
				holo_reverse_url: c.vs_card_packs?.holo_reverse_url ?? null,
				quantity: 0,
				finish: 'normal' as CardFinish,
				owned: false
			};
		});

	// Sort rarest-first; within a rarity, owned before missing, then by name.
	const rank = new Map(RARITIES.map((r, i) => [r.key as string, i]));
	const collection: CollectionCard[] = [...owned, ...unowned].sort((a, b) => {
		const rr = (rank.get(b.rarity) ?? 0) - (rank.get(a.rarity) ?? 0);
		if (rr !== 0) return rr;
		if (a.owned !== b.owned) return a.owned ? -1 : 1;
		return a.name.localeCompare(b.name);
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

	const cardsOwned = owned.reduce((sum, c) => sum + (c.quantity ?? 0), 0);
	const opens = (opensRes.data ?? []) as { cost_vp: number | null; card_count: number | null }[];

	const cr = crateRes.data as {
		total_opens: number | null;
		free_opens: number | null;
		paid_opens: number | null;
		total_vp_won: number | null;
		total_vp_spent: number | null;
		biggest_win: number | null;
		last_open_date: string | null;
	} | null;

	return {
		vp_balance,
		wallet,
		collection,
		collectionOwned: ownedIds.size,
		collectionTotal: ownedIds.size + unowned.length,
		packs,
		stats: {
			packsOpened: opens.length,
			vpSpent: opens.reduce((sum, o) => sum + (o.cost_vp ?? 0), 0),
			cardsPulled: opens.reduce((sum, o) => sum + (o.card_count ?? 0), 0),
			cardsOwned
		},
		crateStats: {
			totalOpens: cr?.total_opens ?? 0,
			freeOpens: cr?.free_opens ?? 0,
			paidOpens: cr?.paid_opens ?? 0,
			vpWon: cr?.total_vp_won ?? 0,
			vpSpent: cr?.total_vp_spent ?? 0,
			biggestWin: cr?.biggest_win ?? 0,
			lastOpen: cr?.last_open_date ?? null
		}
	};
}
