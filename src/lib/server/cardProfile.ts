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
	vs_card_packs: {
		holo_regular_url: string | null;
		holo_reverse_url: string | null;
		slot_finishes: { holo?: number | null; reverse?: number | null }[] | null;
		slot_weights: Record<string, number>[] | null;
		rarity_weights: Record<string, number> | null;
	} | null;
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
			.select('id, name, level, rarity, abilities, flavor, front_url, back_url, layers, full_art, holo_url, sound_url, vs_card_packs!inner(released, holo_regular_url, holo_reverse_url, slot_finishes, slot_weights, rarity_weights)')
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

	// Index what the player owns, by card and by (card, finish).
	const ownedIds = new Set(owned.map((c) => c.id));
	const ownedByKey = new Map<string, CollectionCard>(owned.map((c) => [`${c.id}|${c.finish}`, c]));
	const ownedFinishes = new Map<string, Set<CardFinish>>();
	const ownedSample = new Map<string, CollectionCard>();
	for (const c of owned) {
		(ownedFinishes.get(c.id) ?? ownedFinishes.set(c.id, new Set()).get(c.id)!).add(c.finish);
		if (!ownedSample.has(c.id)) ownedSample.set(c.id, c);
	}

	const catalogById = new Map<string, CatalogRow>(
		((catalogRes.data ?? []) as unknown as CatalogRow[]).map((c) => [c.id, c])
	);

	// Can a slot ever roll a given rarity? Mirrors the roller's fallback chain
	// (gamba.ts makeSlotRoller): a slot's own weights, else the pack's rarity_weights,
	// else uniform over every rarity the pack actually has cards in.
	const hasPositive = (w: Record<string, number> | null | undefined): boolean =>
		!!w && Object.values(w).some((v) => Number(v) > 0);
	const slotCanRollRarity = (
		pack: NonNullable<CatalogRow['vs_card_packs']>,
		slotIndex: number,
		rarity: string
	): boolean => {
		const sw = Array.isArray(pack.slot_weights) ? pack.slot_weights[slotIndex] : null;
		if (hasPositive(sw)) return Number(sw![rarity] ?? 0) > 0;
		if (hasPositive(pack.rarity_weights)) return Number(pack.rarity_weights![rarity] ?? 0) > 0;
		return true; // uniform over present rarities — the card's own rarity is present
	};

	// Which finishes a card can actually have, ordered Holo → Reverse Holo → Normal.
	// Normal is always possible. Holo/Reverse only if the card ISN'T full-art (the
	// foil masks never apply to full-art) AND its pack can produce that finish FOR
	// THIS card's rarity: with no slot_finishes the legacy positional rule lets any
	// non-full-art card land Holo/Reverse; otherwise some slot must both offer the
	// finish (>0%) AND be able to roll the card's rarity.
	const possibleFinishes = (c: CatalogRow): CardFinish[] => {
		if (c.full_art || !c.vs_card_packs) return ['normal'];
		const pack = c.vs_card_packs;
		const sf = Array.isArray(pack.slot_finishes) ? pack.slot_finishes : [];
		const legacy = sf.length === 0;
		const offers = (kind: 'holo' | 'reverse'): boolean => {
			if (legacy) return true;
			return sf.some(
				(s, i) => ((kind === 'holo' ? s?.holo : s?.reverse) ?? 0) > 0 && slotCanRollRarity(pack, i, c.rarity)
			);
		};
		const out: CardFinish[] = [];
		if (offers('holo')) out.push('holo');
		if (offers('reverse')) out.push('reverse');
		out.push('normal');
		return out;
	};

	const greyVariant = (c: CatalogRow, rarity: CardRarity, finish: CardFinish): CollectionCard => ({
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
		finish,
		owned: false
	});

	// Build the collection: one slot per finish a card can have (owned → the real
	// card, otherwise a greyed placeholder). SR ("secret rare") cards stay a single
	// REDACTED mystery spot until the player owns any finish of one — then it's
	// "discovered" and expands to its real variant slots.
	const FINISH_ORDER: CardFinish[] = ['holo', 'reverse', 'normal'];
	const finishRank: Record<CardFinish, number> = { holo: 0, reverse: 1, normal: 2 };
	const collection: CollectionCard[] = [];
	const allCardIds = new Set<string>([...catalogById.keys(), ...ownedIds]);

	for (const id of allCardIds) {
		const cat = catalogById.get(id);
		const discovered = ownedIds.has(id);
		const rarity = (
			cat
				? isValidRarity(cat.rarity)
					? cat.rarity
					: DEFAULT_RARITY
				: ownedSample.get(id)?.rarity ?? DEFAULT_RARITY
		) as CardRarity;

		if (rarity === 'sr' && !discovered) {
			collection.push({
				...hiddenCard(id, rarity),
				// Show the card's real back (the reverse side gives nothing away) so SR
				// slots use the uploaded back, not the default black one. Front/name stay redacted.
				back_url: cat?.back_url ?? null,
				quantity: 0,
				finish: 'normal' as CardFinish,
				owned: false
			});
			continue;
		}

		// Finish slots to show: the ones the card can have, plus any the player owns
		// (so a copy is never hidden even if the pack's odds later dropped that finish).
		const slots = new Set<CardFinish>(cat ? possibleFinishes(cat) : []);
		for (const f of ownedFinishes.get(id) ?? []) slots.add(f);

		for (const finish of FINISH_ORDER) {
			if (!slots.has(finish)) continue;
			const ownedEntry = ownedByKey.get(`${id}|${finish}`);
			if (ownedEntry) collection.push(ownedEntry);
			else if (cat) collection.push(greyVariant(cat, rarity, finish));
		}
	}

	// Rarest-first; within a rarity group each card's variants stay together, ordered
	// Holo → Reverse Holo → Normal.
	const rank = new Map(RARITIES.map((r, i) => [r.key as string, i]));
	collection.sort((a, b) => {
		const rr = (rank.get(b.rarity) ?? 0) - (rank.get(a.rarity) ?? 0);
		if (rr !== 0) return rr;
		const nn = a.name.localeCompare(b.name);
		if (nn !== 0) return nn;
		return finishRank[a.finish] - finishRank[b.finish];
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
		// Count every VARIANT slot (one per finish a card can have) so it matches the
		// grid: owned variants over total obtainable variants. An undiscovered secret
		// rare is a single mystery slot until a finish of it is owned.
		collectionOwned: collection.filter((c) => c.owned).length,
		collectionTotal: collection.length,
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
