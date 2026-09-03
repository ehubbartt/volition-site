// Connect Four tile pool — the candidate boss drops an admin curates the event's 250
// tiles from, and a one-click spread across the difficulty range to start from.
//
// This is the TEAM-WIDE analogue of personalBoard.ts's `missingCandidates`: the same
// itemEhb.json universe scored by the same `bestEhbSource` maths (so a tile's difficulty
// means the same thing here as it does on a personal board), minus the per-player
// "already in their collection log" filter — a clan of 120 has everything already, so
// filtering on ownership would empty the pool.
//
// Boss drops only. Non-boss clog items (itemEhc.json) are deliberately excluded: this
// event is tracked from Dink LOOT notifications, and a clog-only item doesn't reliably
// fire one.

import itemEhbData from './data/itemEhb.json';
import { bestEhbSource, isPetItem, type ItemEhb } from '$lib/ehb';
import { getEhbOverrides, getExcludedItemIds } from './ehbOverrides';
import { DECK_SIZE, type TileRef } from '$lib/connect4/rules';

const ITEM_EHB = itemEhbData as ItemEhb[];

// Cosmetics nobody grinds on purpose, and jars, which are a coin-flip on a rare table.
const COSMETIC_EXCLUDE = /3rd age|gilded/i;
const JAR_EXCLUDE = /\bjar\b/i;

export interface PoolCandidate extends TileRef {
	ehb: number;
	/** The mechanic behind the cheapest source — 'kill', 'toa', 'cox'… for display. */
	mechanic: string;
}

export interface PoolOptions {
	/** Cheapest tile to offer, in efficient hours. */
	minEhb?: number;
	/** Dearest tile to offer, in efficient hours. */
	maxEhb?: number;
	includePets?: boolean;
	includeJars?: boolean;
	includeCosmetics?: boolean;
}

/**
 * The per-game generator filters, as stored in structure.connect4.pool_opts. They shape
 * what the curation list OFFERS (and what auto/random fill draws from) — never what a
 * saved pool may contain, so tightening them cannot invalidate ticked tiles.
 */
export interface StoredPoolOpts {
	min_ehb: number;
	max_ehb: number | null;
	pets: boolean;
	jars: boolean;
	cosmetics: boolean;
}

export function normalizePoolOpts(raw?: Partial<StoredPoolOpts> | null): StoredPoolOpts {
	const num = (v: unknown): number | null => {
		const n = Number(v);
		return isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null;
	};
	return {
		min_ehb: num(raw?.min_ehb) ?? 0,
		max_ehb: num(raw?.max_ehb),
		pets: raw?.pets === true,
		jars: raw?.jars === true,
		cosmetics: raw?.cosmetics === true
	};
}

export const toPoolOptions = (o: StoredPoolOpts): PoolOptions => ({
	minEhb: o.min_ehb || undefined,
	maxEhb: o.max_ehb ?? undefined,
	includePets: o.pets,
	includeJars: o.jars,
	includeCosmetics: o.cosmetics
});

/** Everything, unfiltered — what setPool validates against so filters never eat ticks. */
export const ALL_POOL_OPTIONS: PoolOptions = {
	includePets: true,
	includeJars: true,
	includeCosmetics: true
};

/**
 * Every boss drop worth putting on a board, cheapest first. Admin EHB overrides and the
 * item exclusion list are honoured, so a drop the maintainer has already pinned or
 * banished behaves the same here as everywhere else.
 */
export async function poolCandidates(opts: PoolOptions = {}): Promise<PoolCandidate[]> {
	const overrides = await getEhbOverrides();
	const excluded = await getExcludedItemIds();
	const min = opts.minEhb ?? 0;
	const max = opts.maxEhb ?? Infinity;

	const out: PoolCandidate[] = [];
	for (const item of ITEM_EHB) {
		if (excluded.has(item.id)) continue;
		if (!opts.includePets && isPetItem(item.name)) continue;
		if (!opts.includeJars && JAR_EXCLUDE.test(item.name)) continue;
		if (!opts.includeCosmetics && COSMETIC_EXCLUDE.test(item.name)) continue;
		const best = bestEhbSource(item, undefined, overrides);
		if (!best || !isFinite(best.ehb) || best.ehb <= 0) continue;
		if (best.ehb < min || best.ehb > max) continue;
		out.push({
			item_id: item.id,
			item_name: item.name,
			source: best.src?.s ?? null,
			ehb: best.ehb,
			mechanic: best.src?.t ?? 'kill'
		});
	}
	return out.sort((a, b) => a.ehb - b.ehb);
}

/**
 * A starting selection of `count` tiles spread evenly across the candidate difficulty
 * range: the list is split into `count` equal bands and one tile is taken from each, so
 * the deck is neither all Bandos tassets nor all Zulrah scales. Deterministic (it takes
 * the middle of each band) — an admin who wants a different mix edits the selection
 * rather than re-rolling and hoping.
 */
export function autoSelect(candidates: PoolCandidate[], count = DECK_SIZE): PoolCandidate[] {
	if (candidates.length <= count) return candidates.slice();
	const out: PoolCandidate[] = [];
	const band = candidates.length / count;
	for (let i = 0; i < count; i++) {
		const idx = Math.min(candidates.length - 1, Math.floor(i * band + band / 2));
		out.push(candidates[idx]);
	}
	return out;
}

/**
 * The re-rollable cousin of autoSelect: the same equal difficulty bands, but a RANDOM
 * pick from each instead of the middle — every roll is a different deck with the same
 * overall difficulty curve. For admins who asked for "randomly select boss items";
 * the deterministic spread stays the predictable default.
 */
export function randomSelect(candidates: PoolCandidate[], count = DECK_SIZE): PoolCandidate[] {
	if (candidates.length <= count) return candidates.slice();
	const out: PoolCandidate[] = [];
	const band = candidates.length / count;
	for (let i = 0; i < count; i++) {
		// band > 1 here, so floor((i+1)·band) ≥ lo+1 and consecutive bands NEVER share an
		// index — ceil() here once produced overlapping seams and a duplicate-item pool.
		const lo = Math.floor(i * band);
		const hi = Math.max(lo, Math.min(candidates.length - 1, Math.floor((i + 1) * band) - 1));
		out.push(candidates[lo + Math.floor(Math.random() * (hi - lo + 1))]);
	}
	return out;
}

/**
 * Strip a curated selection down to what actually gets stored on the event — keeping a
 * custom tile's group members and quantity, which ride through curation untouched.
 */
export function toTileRefs(
	picked: Pick<PoolCandidate, 'item_id' | 'item_name' | 'source' | 'ehb' | 'any_of' | 'qty'>[]
): TileRef[] {
	return picked.map((p) => ({
		item_id: p.item_id,
		item_name: p.item_name,
		source: p.source ?? null,
		ehb: p.ehb,
		...(p.any_of?.length ? { any_of: p.any_of } : {}),
		...(p.qty && p.qty > 1 ? { qty: p.qty } : {})
	}));
}
