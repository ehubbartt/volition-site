import { db } from './db';
import { RARITIES } from '$lib/cards/rarity';
import type { CardFinish } from '$lib/cards/finishes';

export interface CardGrant {
	card_id: string;
	finish: CardFinish;
}

// Builds a weighted card picker for a pack pool. The pool is grouped by rarity
// ONCE; the returned pick(weights) function rolls a single card for a given set
// of rarity weights — call it per slot with that slot's weights. The card is
// chosen in two steps: pick a RARITY by the supplied weights, then a card of
// that rarity uniformly. Weights are relative and only count rarities that
// actually have cards in the pool. If no positive weights are supplied (an
// unconfigured slot), it falls back to weighting each rarity by its card count
// (= uniform over all cards).
export function makeSlotRoller<T extends { rarity: string }>(
	pool: T[]
): (weights: Record<string, number> | null | undefined) => T {
	const groups = new Map<string, T[]>();
	for (const c of pool) {
		const arr = groups.get(c.rarity) ?? [];
		arr.push(c);
		groups.set(c.rarity, arr);
	}
	const rarities = [...groups.keys()];

	return (weights) => {
		let w = rarities.map((r) => Math.max(0, Number(weights?.[r] ?? 0)));
		if (w.reduce((a, b) => a + b, 0) <= 0) {
			w = rarities.map((r) => groups.get(r)!.length); // uniform over all cards
		}
		const total = w.reduce((a, b) => a + b, 0);

		let rnd = Math.random() * total;
		let idx = w.length - 1;
		for (let i = 0; i < w.length; i++) {
			rnd -= w[i];
			if (rnd < 0) {
				idx = i;
				break;
			}
		}
		const g = groups.get(rarities[idx])!;
		return g[Math.floor(Math.random() * g.length)];
	};
}

// Rolls ONE pack open and assigns finishes — the single source of truth for the
// open logic, shared by the real /gamba open and the admin simulator so their odds
// match exactly. `pick` is a makeSlotRoller() roller (build it once, reuse across
// many opens). Each of `cardsPerPack` cards is rolled by its SLOT's weights
// (falling back to the per-pack `rarityWeights`, then uniform).
//
// Finishes: if `slotFinishes` is configured, each slot's card rolls Holo/Reverse by
// that slot's percentages (remainder Normal). If it's empty (a pack not yet set up
// in the new editor), it falls back to the LEGACY positional rule: the last card is
// Holo and the second-to-last is Reverse. Full-art cards always stay Normal.
//
// Reveal/return order: slot order when any per-slot config exists, else rarest-last.
export interface PackRollConfig {
	cardsPerPack: number;
	slotWeights: Record<string, number>[];
	rarityWeights: Record<string, number> | null;
	slotFinishes: { holo: number; reverse: number }[];
}

export function rollOnePack<T extends { rarity: string; full_art?: boolean | null }>(
	pick: (weights: Record<string, number> | null | undefined) => T,
	config: PackRollConfig
): { card: T; finish: CardFinish }[] {
	const n = Math.max(1, config.cardsPerPack);
	const hasSlots = config.slotWeights.some((s) => s && Object.keys(s).length > 0);
	const useSlotFinishes = config.slotFinishes.length > 0;

	const rolled: { card: T; finish: CardFinish }[] = [];
	for (let i = 0; i < n; i++) {
		const slot = config.slotWeights[i];
		const w = slot && Object.keys(slot).length > 0 ? slot : config.rarityWeights;
		const card = pick(w);

		let finish: CardFinish = 'normal';
		// Full-art cards never get a holo finish (the masks don't apply to them).
		if (useSlotFinishes && !card.full_art) {
			const sf = config.slotFinishes[i] ?? { holo: 0, reverse: 0 };
			const holo = Math.max(0, sf.holo ?? 0);
			const reverse = Math.max(0, sf.reverse ?? 0);
			const r = Math.random() * 100;
			if (r < holo) finish = 'holo';
			else if (r < holo + reverse) finish = 'reverse';
		}
		rolled.push({ card, finish });
	}

	// Reveal order: rarest-last only for fully-unconfigured packs; any per-slot
	// config means the slot order IS the reveal order.
	if (!hasSlots && !useSlotFinishes) {
		const rank = new Map(RARITIES.map((r, i) => [r.key as string, i]));
		rolled.sort((a, b) => (rank.get(a.card.rarity) ?? 0) - (rank.get(b.card.rarity) ?? 0));
	}

	// Legacy positional finishes when slot finishes aren't configured.
	if (!useSlotFinishes) {
		const m = rolled.length;
		if (m >= 1 && !rolled[m - 1].card.full_art) rolled[m - 1].finish = 'holo';
		if (m >= 2 && !rolled[m - 2].card.full_art) rolled[m - 2].finish = 'reverse';
	}

	return rolled;
}

// Grants rolled cards to a user's collection (vs_user_cards), incrementing
// quantity for cards they already own. Each (card, finish) pair is a SEPARATE
// inventory row — a Normal copy and a Holo copy of the same card stack apart.
// Site-owned tables (unlike VP, which lives in the bot's players table — see
// playerStats.ts). Used by the /gamba open flow after VP has been spent.
export async function grantCards(
	userId: string,
	grants: CardGrant[]
): Promise<{ ok: true } | { ok: false; error: string }> {
	if (grants.length === 0) return { ok: true };
	const sb = db();

	// Tally how many of each distinct (card, finish) were rolled.
	const counts = new Map<string, number>();
	for (const g of grants) {
		const key = `${g.card_id}|${g.finish}`;
		counts.set(key, (counts.get(key) ?? 0) + 1);
	}
	const keys = [...counts.keys()];
	const cardIds = [...new Set(grants.map((g) => g.card_id))];

	// Read current rows for the affected cards so we increment rather than
	// overwrite, and preserve first_acquired_at for entries already owned.
	const { data: existing, error: exErr } = await sb
		.from('vs_user_cards')
		.select('card_id, finish, quantity, first_acquired_at')
		.eq('user_id', userId)
		.in('card_id', cardIds);
	if (exErr) return { ok: false, error: exErr.message };

	const have = new Map<string, number>();
	const firstAt = new Map<string, string>();
	for (const row of existing ?? []) {
		const key = `${row.card_id}|${row.finish}`;
		have.set(key, (row.quantity as number) ?? 0);
		if (row.first_acquired_at) firstAt.set(key, row.first_acquired_at as string);
	}

	const now = new Date().toISOString();
	const rows = keys.map((key) => {
		const [card_id, finish] = key.split('|');
		return {
			user_id: userId,
			card_id,
			finish,
			quantity: (have.get(key) ?? 0) + (counts.get(key) ?? 0),
			first_acquired_at: firstAt.get(key) ?? now,
			updated_at: now
		};
	});

	const { error: upErr } = await sb
		.from('vs_user_cards')
		.upsert(rows, { onConflict: 'user_id,card_id,finish' });
	if (upErr) return { ok: false, error: upErr.message };
	return { ok: true };
}
