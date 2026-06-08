import { redirect, error, fail } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { isCardTester } from '$lib/server/auth';
import { getPlayerVp, spendPlayerVp, grantPlayerVp } from '$lib/server/playerStats';
import { grantCards, makeSlotRoller, rollOnePack, type CardGrant } from '$lib/server/gamba';
import { isValidRarity, DEFAULT_RARITY, toCardLayers, type Card, type CardAbility, type CardRarity } from '$lib/cards/rarity';
import { type CardFinish } from '$lib/cards/finishes';
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

// Player-facing pack store. Gated to card testers for now (CARD_TESTER_DISCORD_IDS)
// while the card game is in progress — flip this to "any logged-in user" to launch.
export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) throw redirect(303, '/');
	if (!isCardTester(locals.user)) throw error(403, 'Not allowed');

	const [vp_balance, packsRes, cardsRes] = await Promise.all([
		getPlayerVp(locals.user.discord_id, locals.user.rsn),
		db()
			.from('vs_card_packs')
			.select('id, name, description, cost_vp, cards_per_pack, front_url, back_url')
			.eq('released', true)
			.order('cost_vp', { ascending: true }),
		db().from('vs_cards').select('pack_id')
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

	return { vp_balance, packs };
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
