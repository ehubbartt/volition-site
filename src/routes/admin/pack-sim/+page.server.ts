import { redirect, error, fail } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { isCardAdmin } from '$lib/server/auth';
import { makeSlotRoller, rollOnePack } from '$lib/server/gamba';
import {
	isValidRarity,
	DEFAULT_RARITY,
	RARITIES,
	RARITY_BY_KEY,
	type CardRarity
} from '$lib/cards/rarity';
import { FINISH_BY_KEY, type CardFinish } from '$lib/cards/finishes';
import type { Actions, PageServerLoad } from './$types';

// Bulk pack-opening simulator (dev tool): rolls many opens with the EXACT same
// logic as the real /gamba open (rollOnePack), but spends no VP and saves nothing.
const MAX_PACKS = 100_000;
const MAX_TRIALS = 10_000;

interface PoolRow {
	id: string;
	name: string;
	rarity: string;
	full_art: boolean | null;
}

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) throw redirect(303, '/');
	if (!isCardAdmin(locals.user)) throw error(403, 'Not allowed');

	const [packsRes, cardsRes] = await Promise.all([
		db().from('vs_card_packs').select('id, name, cards_per_pack').order('name', { ascending: true }),
		db().from('vs_cards').select('pack_id')
	]);
	if (packsRes.error) throw error(500, packsRes.error.message);
	if (cardsRes.error) throw error(500, cardsRes.error.message);

	const counts = new Map<string, number>();
	for (const r of cardsRes.data ?? []) {
		if (r.pack_id) counts.set(r.pack_id, (counts.get(r.pack_id) ?? 0) + 1);
	}

	const packs = (packsRes.data ?? []).map((p) => ({
		id: p.id,
		name: p.name,
		cards_per_pack: p.cards_per_pack,
		card_count: counts.get(p.id) ?? 0
	}));

	return { packs, maxPacks: MAX_PACKS };
};

export const actions: Actions = {
	simulate: async ({ locals, request }) => {
		if (!locals.user || !isCardAdmin(locals.user)) throw error(403, 'Not allowed');

		const form = await request.formData();
		const packId = form.get('pack_id')?.toString();
		// goal: 'count' = open exactly N; 'cards' = until every card seen (any finish);
		// 'variations' = until every obtainable (card, finish) seen.
		const goalRaw = form.get('goal')?.toString();
		const goal: 'count' | 'cards' | 'variations' =
			goalRaw === 'cards' || goalRaw === 'variations' ? goalRaw : 'count';
		const count = Math.floor(Number(form.get('count') ?? 0));
		// How many independent runs to average over (only the "until" goals use it).
		const trials = Math.max(1, Math.min(MAX_TRIALS, Math.floor(Number(form.get('trials') ?? 1)) || 1));
		if (!packId) return fail(400, { error: 'Pick a pack' });
		if (goal === 'count') {
			if (!Number.isFinite(count) || count < 1) {
				return fail(400, { error: 'Enter how many packs to open' });
			}
			if (count > MAX_PACKS) {
				return fail(400, { error: `Max ${MAX_PACKS.toLocaleString()} packs at once` });
			}
		}

		const { data: pack, error: pErr } = await db()
			.from('vs_card_packs')
			.select('id, name, cards_per_pack, slot_weights, rarity_weights, slot_finishes')
			.eq('id', packId)
			.maybeSingle();
		if (pErr) return fail(500, { error: pErr.message });
		if (!pack) return fail(404, { error: 'Pack not found' });

		const { data: poolRows, error: poolErr } = await db()
			.from('vs_cards')
			.select('id, name, rarity, full_art')
			.eq('pack_id', packId);
		if (poolErr) return fail(500, { error: poolErr.message });
		const pool = (poolRows ?? []) as PoolRow[];
		if (pool.length === 0) return fail(400, { error: 'This pack has no cards.' });
		// Normalize legacy/invalid rarities (see gamba open) so they group + weight as
		// Bronze rather than forming an unreachable 0-weight group.
		for (const c of pool) if (!isValidRarity(c.rarity)) c.rarity = DEFAULT_RARITY;

		const cardsPerPack = Math.max(1, pack.cards_per_pack ?? 5);
		const slotWeights = (Array.isArray(pack.slot_weights) ? pack.slot_weights : []) as Record<
			string,
			number
		>[];
		const slotFinishes = (Array.isArray(pack.slot_finishes) ? pack.slot_finishes : []) as {
			holo: number;
			reverse: number;
		}[];
		const rarityWeights = (pack.rarity_weights as Record<string, number> | null) ?? null;
		const pick = makeSlotRoller(pool);
		const config = { cardsPerPack, slotWeights, rarityWeights, slotFinishes };

		// ---- Targets for the "open until…" goals ----
		// IMPORTANT: only count cards/variations that are actually OBTAINABLE with this
		// pack's odds. A card whose rarity has 0 weight in every slot can never drop, so
		// including it would make the goal impossible (run to the cap forever).

		// Which rarities a slot can actually roll (mirrors makeSlotRoller: positive
		// weights present in the pool, else uniform over all present rarities).
		const presentRarities = new Set(pool.map((c) => c.rarity));
		const slotRaritySets: Set<string>[] = [];
		for (let i = 0; i < cardsPerPack; i++) {
			const slot = slotWeights[i];
			const w = slot && Object.keys(slot).length > 0 ? slot : rarityWeights ?? {};
			const pos = [...presentRarities].filter((r) => (Number(w?.[r]) || 0) > 0);
			slotRaritySets.push(new Set(pos.length ? pos : presentRarities));
		}
		// A rarity is reachable if any slot can roll it → all its cards are reachable.
		const reachableRarities = new Set<string>();
		for (const s of slotRaritySets) for (const r of s) reachableRarities.add(r);

		const useSlotFinishes = slotFinishes.length > 0;
		const targetCardSet = new Set<string>();
		const targetVarSet = new Set<string>();
		for (const c of pool) {
			if (!reachableRarities.has(c.rarity)) continue; // can never drop — skip
			targetCardSet.add(c.id);

			// The finishes this card can actually come in, across the slots it can drop in.
			const finishes = new Set<CardFinish>();
			for (let i = 0; i < cardsPerPack; i++) {
				if (!slotRaritySets[i].has(c.rarity)) continue;
				if (c.full_art) {
					finishes.add('normal'); // full-art never holos
				} else if (useSlotFinishes) {
					const sf = slotFinishes[i] ?? { holo: 0, reverse: 0 };
					const holo = Math.max(0, Math.min(100, Number(sf.holo) || 0));
					const reverse = Math.max(0, Math.min(100, Number(sf.reverse) || 0));
					if (holo > 0) finishes.add('holo');
					if (reverse > 0) finishes.add('reverse');
					if (100 - holo - reverse > 0) finishes.add('normal');
				} else {
					// legacy positional — approximate: any non-full-art card can land either
					finishes.add('normal');
					finishes.add('holo');
					finishes.add('reverse');
				}
			}
			if (finishes.size === 0) finishes.add('normal'); // safety (shouldn't happen)
			for (const f of finishes) targetVarSet.add(`${c.id}|${f}`);
		}

		// ---- Run ----
		// 'count': one run of N packs. 'cards'/'variations': run `trials` independent
		// runs, each opening until the target is collected, then average the packs needed.
		const PER_TRIAL_CAP = 2_000_000; // safety per trial
		const TOTAL_CAP = 12_000_000; // safety across all trials (bounds runtime)

		const rarityCount = new Map<string, number>();
		const finishCount: Record<CardFinish, number> = { normal: 0, holo: 0, reverse: 0 };
		const perCard = new Map<
			string,
			{ name: string; rarity: string; full_art: boolean; total: number; holo: number; reverse: number }
		>();
		const tally = (card: PoolRow, finish: CardFinish) => {
			rarityCount.set(card.rarity, (rarityCount.get(card.rarity) ?? 0) + 1);
			finishCount[finish] = (finishCount[finish] ?? 0) + 1;
			let pc = perCard.get(card.id);
			if (!pc) {
				pc = { name: card.name, rarity: card.rarity, full_art: !!card.full_art, total: 0, holo: 0, reverse: 0 };
				perCard.set(card.id, pc);
			}
			pc.total++;
			if (finish === 'holo') pc.holo++;
			else if (finish === 'reverse') pc.reverse++;
		};

		let totalOpened = 0;
		const packsNeeded: number[] = [];
		let completedTrials = 0;
		let truncated = false;

		if (goal === 'count') {
			for (let p = 0; p < count; p++) {
				for (const { card, finish } of rollOnePack<PoolRow>(pick, config)) tally(card, finish);
			}
			totalOpened = count;
		} else {
			const target = goal === 'cards' ? targetCardSet.size : targetVarSet.size;
			for (let t = 0; t < trials; t++) {
				if (totalOpened >= TOTAL_CAP) {
					truncated = true;
					break;
				}
				const seenCards = new Set<string>();
				const seenVars = new Set<string>();
				let openedThis = 0;
				let done = false;
				while (openedThis < PER_TRIAL_CAP && totalOpened < TOTAL_CAP) {
					const cards = rollOnePack<PoolRow>(pick, config);
					openedThis++;
					totalOpened++;
					for (const { card, finish } of cards) {
						tally(card, finish);
						seenCards.add(card.id);
						seenVars.add(`${card.id}|${finish}`);
					}
					const found = goal === 'cards' ? seenCards.size : seenVars.size;
					if (found >= target) {
						done = true;
						break;
					}
				}
				if (done) {
					packsNeeded.push(openedThis);
					completedTrials++;
				} else {
					truncated = true;
				}
			}
		}

		// Average packs-to-complete across the trials that finished.
		const sortedNeeded = [...packsNeeded].sort((a, b) => a - b);
		const avgPacks = sortedNeeded.length
			? sortedNeeded.reduce((a, b) => a + b, 0) / sortedNeeded.length
			: 0;
		const minPacks = sortedNeeded.length ? sortedNeeded[0] : 0;
		const maxPacks = sortedNeeded.length ? sortedNeeded[sortedNeeded.length - 1] : 0;
		const pctl = (p: number) =>
			sortedNeeded.length
				? sortedNeeded[Math.min(sortedNeeded.length - 1, Math.floor((p / 100) * sortedNeeded.length))]
				: 0;
		const medPacks = pctl(50);
		const p90Packs = pctl(90);

		// Completion curve (CDF): at x packs, what % of trials have finished. Sampled
		// across [0, max] so the page can draw it as a smooth line.
		const cdf: { x: number; pct: number }[] = [];
		if (sortedNeeded.length) {
			const n = sortedNeeded.length;
			const POINTS = 80;
			let j = 0;
			for (let k = 0; k <= POINTS; k++) {
				const x = Math.round((maxPacks * k) / POINTS);
				while (j < n && sortedNeeded[j] <= x) j++;
				cdf.push({ x, pct: (j / n) * 100 });
			}
		}

		const complete = goal === 'count' ? true : completedTrials === trials && !truncated;

		const totalCards = totalOpened * cardsPerPack;
		const pct = (n: number) => (totalCards ? (n / totalCards) * 100 : 0);

		const rarities = RARITIES.filter((r) => (rarityCount.get(r.key) ?? 0) > 0).map((r) => ({
			key: r.key,
			label: r.label,
			color: r.color,
			count: rarityCount.get(r.key) ?? 0,
			pct: pct(rarityCount.get(r.key) ?? 0)
		}));

		const finishes = (['normal', 'holo', 'reverse'] as CardFinish[]).map((k) => ({
			key: k,
			label: FINISH_BY_KEY[k].label,
			count: finishCount[k],
			pct: pct(finishCount[k])
		}));

		// Rarest first, then most-pulled within a rarity.
		const rank = new Map(RARITIES.map((r, i) => [r.key as string, i]));
		const cards = [...perCard.values()]
			.map((c) => {
				const rk = (isValidRarity(c.rarity) ? c.rarity : DEFAULT_RARITY) as CardRarity;
				return {
					name: c.name,
					rarity: rk,
					label: RARITY_BY_KEY[rk].label,
					color: RARITY_BY_KEY[rk].color,
					full_art: c.full_art,
					count: c.total,
					pct: pct(c.total),
					perPack: totalOpened ? c.total / totalOpened : 0,
					normal: c.total - c.holo - c.reverse,
					holo: c.holo,
					reverse: c.reverse
				};
			})
			.sort((a, b) => {
				const rr = (rank.get(b.rarity) ?? 0) - (rank.get(a.rarity) ?? 0);
				return rr !== 0 ? rr : b.count - a.count;
			});

		return {
			ok: true,
			goal,
			packName: pack.name,
			packs: totalOpened,
			cardsPerPack,
			totalCards,
			complete,
			trials,
			completedTrials,
			truncated,
			avgPacks,
			minPacks,
			maxPacks,
			medPacks,
			p90Packs,
			cdf,
			targetCards: targetCardSet.size,
			targetVariations: targetVarSet.size,
			rarities,
			finishes,
			cards
		};
	}
};
