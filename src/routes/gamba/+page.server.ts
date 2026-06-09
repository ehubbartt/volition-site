import { redirect, error, fail } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { isCardTester } from '$lib/server/auth';
import { getPlayerVp, spendPlayerVp, grantPlayerVp } from '$lib/server/playerStats';
import { grantCards, logPackOpen, makeSlotRoller, rollOnePack, type CardGrant } from '$lib/server/gamba';
import { isValidRarity, DEFAULT_RARITY, RARE_RARITIES, toCardLayers, type Card, type CardAbility, type CardRarity } from '$lib/cards/rarity';
import { isValidFinish, type CardFinish } from '$lib/cards/finishes';
import type { Actions, PageServerLoad } from './$types';

interface CardRow {
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
}

interface RarePullRow {
	id: string;
	card_name: string;
	rarity: string;
	finish: string;
	pulled_at: string;
	vs_users: { rsn: string | null; discord_username: string | null } | null;
	vs_cards: { front_url: string | null; full_art: boolean | null } | null;
	vs_pack_opens: { pack_name: string | null } | null;
}

export interface RarePull {
	id: string;
	cardName: string;
	rarity: CardRarity;
	finish: CardFinish;
	frontUrl: string | null;
	fullArt: boolean;
	by: string; // display name
	rsn: string | null; // for the /u/[rsn] link (null = no link)
	packName: string | null; // which pack it was opened from
	pulledAt: string;
}

// Player-facing pack store. Gated to card testers for now (CARD_TESTER_DISCORD_IDS)
// while the card game is in progress — flip this to "any logged-in user" to launch.
export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) throw redirect(303, '/');
	if (!isCardTester(locals.user)) throw error(403, 'Not allowed');

	const [vp_balance, packsRes, cardsRes, raresRes] = await Promise.all([
		getPlayerVp(locals.user.discord_id, locals.user.rsn),
		db()
			.from('vs_card_packs')
			.select('id, name, description, cost_vp, cards_per_pack, front_url, back_url')
			.eq('released', true)
			.order('cost_vp', { ascending: true }),
		db().from('vs_cards').select('pack_id'),
		// Recently opened rares (rune+), newest first — the live drop ticker. Reads
		// the pack-open line items directly (the rarity filter is a plain indexed query).
		db()
			.from('vs_pack_open_cards')
			.select(
				'id, card_name, rarity, finish, pulled_at, vs_users(rsn, discord_username), vs_cards(front_url, full_art), vs_pack_opens(pack_name)'
			)
			.in('rarity', RARE_RARITIES)
			.order('pulled_at', { ascending: false })
			.limit(20)
	]);

	if (packsRes.error) throw error(500, packsRes.error.message);

	// How many cards each set has, so we can flag/disable empty packs.
	const counts = new Map<string, number>();
	for (const r of cardsRes.data ?? []) {
		if (r.pack_id) counts.set(r.pack_id, (counts.get(r.pack_id) ?? 0) + 1);
	}

	const packs = (packsRes.data ?? []).map((p) => ({
		...p,
		card_count: counts.get(p.id) ?? 0
	}));

	const recentRares: RarePull[] = ((raresRes.data ?? []) as unknown as RarePullRow[]).map((r) => ({
		id: r.id,
		cardName: r.card_name,
		rarity: (isValidRarity(r.rarity) ? r.rarity : DEFAULT_RARITY) as CardRarity,
		finish: (isValidFinish(r.finish) ? r.finish : 'normal') as CardFinish,
		frontUrl: r.vs_cards?.front_url ?? null,
		fullArt: !!r.vs_cards?.full_art,
		by: r.vs_users?.rsn || r.vs_users?.discord_username || 'Someone',
		rsn: r.vs_users?.rsn ?? null,
		packName: r.vs_pack_opens?.pack_name ?? null,
		pulledAt: r.pulled_at
	}));

	return { vp_balance, packs, recentRares };
};

export const actions: Actions = {
	open: async ({ locals, request }) => {
		if (!locals.user || !isCardTester(locals.user)) throw error(403, 'Not allowed');

		const form = await request.formData();
		const packId = form.get('pack_id')?.toString();
		if (!packId) return fail(400, { error: 'Missing pack' });

		// Pack must exist AND be released.
		const { data: pack, error: pErr } = await db()
			.from('vs_card_packs')
			.select('id, name, cost_vp, cards_per_pack, rarity_weights, slot_weights, slot_finishes, front_url, back_url, released, holo_regular_url, holo_reverse_url')
			.eq('id', packId)
			.maybeSingle();
		if (pErr) return fail(500, { error: pErr.message });
		if (!pack || !pack.released) return fail(404, { error: 'That pack is not available.' });

		// Card pool for this set.
		const { data: poolRows, error: poolErr } = await db()
			.from('vs_cards')
			.select('id, name, level, rarity, abilities, flavor, front_url, back_url, layers, full_art, holo_url, sound_url')
			.eq('pack_id', packId);
		if (poolErr) return fail(500, { error: poolErr.message });
		const pool = (poolRows ?? []) as CardRow[];
		if (pool.length === 0) return fail(400, { error: 'This pack has no cards yet.' });
		// Normalize legacy/invalid rarities so they group + weight correctly. A card
		// whose stored rarity isn't a current key shows as Bronze in admin (fallback)
		// but would otherwise form its own 0-weight group in the roller and never drop.
		for (const c of pool) if (!isValidRarity(c.rarity)) c.rarity = DEFAULT_RARITY;

		const cost = pack.cost_vp ?? 0;
		const n = Math.max(1, pack.cards_per_pack ?? 5);

		// Roll the pack — shared logic with the admin simulator (see gamba.ts) so the
		// odds match: per-slot rarity weights, slot/rarest-last order, and the
		// positional Holo / Reverse-Holo finishes (full-art cards stay Normal).
		const pick = makeSlotRoller(pool);
		const rolled = rollOnePack<CardRow>(pick, {
			cardsPerPack: n,
			slotWeights: (Array.isArray(pack.slot_weights) ? pack.slot_weights : []) as Record<
				string,
				number
			>[],
			rarityWeights: (pack.rarity_weights as Record<string, number> | null) ?? null,
			slotFinishes: (Array.isArray(pack.slot_finishes) ? pack.slot_finishes : []) as {
				holo: number;
				reverse: number;
			}[]
		});

		// 1) Spend VP (optimistic — only if affordable and unchanged).
		const spend = await spendPlayerVp(locals.user.discord_id, locals.user.rsn, cost);
		if (!spend.ok) {
			const msg =
				spend.reason === 'insufficient'
					? `Not enough VP — this pack costs ${cost.toLocaleString()} VP and you have ${spend.balance.toLocaleString()}.`
					: spend.reason === 'no_player'
						? 'No RuneScape player record is linked to your account, so you have no VP to spend.'
						: 'Could not complete the purchase — please try again.';
			return fail(400, { error: msg, balance: spend.balance });
		}

		// 2) Grant the cards (each card + finish is a separate inventory entry). If
		// that fails, refund the VP.
		const grants: CardGrant[] = rolled.map((r) => ({ card_id: r.card.id, finish: r.finish }));
		const grant = await grantCards(locals.user.id, grants);
		if (!grant.ok) {
			await grantPlayerVp(locals.user.discord_id, locals.user.rsn, cost);
			return fail(500, { error: 'Could not add the cards to your collection — your VP was refunded.' });
		}

		// 3) Log the open — header + one line per card (powers player stats and the
		// rare-pull feed). Best-effort: never undoes the already-completed open.
		await logPackOpen({
			userId: locals.user.id,
			packId: pack.id,
			packName: pack.name,
			costVp: cost,
			cards: rolled.map((r) => ({
				card_id: r.card.id,
				card_name: r.card.name,
				rarity: r.card.rarity,
				finish: r.finish
			}))
		});

		const opened: (Card & { finish: CardFinish })[] = rolled.map((r) => ({
			id: r.card.id,
			name: r.card.name,
			level: r.card.level,
			rarity: (isValidRarity(r.card.rarity) ? r.card.rarity : DEFAULT_RARITY) as CardRarity,
			abilities: r.card.abilities ?? [],
			flavor: r.card.flavor,
			front_url: r.card.front_url,
			back_url: r.card.back_url,
			layers: toCardLayers(r.card.layers),
			full_art: !!r.card.full_art,
			holo_url: r.card.holo_url,
			sound_url: r.card.sound_url,
			holo_regular_url: (pack.holo_regular_url as string | null) ?? null,
			holo_reverse_url: (pack.holo_reverse_url as string | null) ?? null,
			finish: r.finish
		}));

		return {
			ok: true,
			opened,
			pack: { name: pack.name, front_url: pack.front_url, back_url: pack.back_url },
			balance: spend.balance
		};
	}
};
