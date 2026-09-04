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

// Jars are a coin-flip on a rare table, so they hide behind a toggle.
const JAR_EXCLUDE = /\bjar\b/i;

export interface PoolCandidate extends TileRef {
	ehb: number;
	/** The mechanic behind the cheapest source — 'kill', 'toa', 'cox'… for display. */
	mechanic: string;
	/** EVERY boss that drops the item, when there is more than the displayed cheapest —
	 *  so filtering by a boss's name surfaces its whole drop table, not just the items
	 *  it happens to be the cheapest source for. */
	sources?: string[];
}

export interface PoolOptions {
	/** Cheapest tile to offer, in efficient hours. */
	minEhb?: number;
	/** Dearest tile to offer, in efficient hours. */
	maxEhb?: number;
	includePets?: boolean;
	includeJars?: boolean;
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
		jars: raw?.jars === true
	};
}

export const toPoolOptions = (o: StoredPoolOpts): PoolOptions => ({
	minEhb: o.min_ehb || undefined,
	maxEhb: o.max_ehb ?? undefined,
	includePets: o.pets,
	includeJars: o.jars
});

/** Everything, unfiltered — what setPool validates against so filters never eat ticks. */
export const ALL_POOL_OPTIONS: PoolOptions = {
	includePets: true,
	includeJars: true
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
		const best = bestEhbSource(item, undefined, overrides);
		if (!best || !isFinite(best.ehb) || best.ehb <= 0) continue;
		if (best.ehb < min || best.ehb > max) continue;
		out.push({
			item_id: item.id,
			item_name: item.name,
			source: best.src?.s ?? null,
			ehb: best.ehb,
			mechanic: best.src?.t ?? 'kill',
			...(item.sources.length > 1 ? { sources: item.sources.map((s) => s.s) } : {})
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
 * The fill that always fills. With enough distinct candidates it IS autoSelect /
 * randomSelect; with fewer candidates than board cells it manufactures the shortfall
 * from ×N-drops variants (a tile needing N drops is effectively N× its EHB) and copies,
 * keeping the effective difficulty (ehb × drops) evenly spread across the offered
 * range. One drops value per item — every copy of an item shares its knob — and at
 * most 20 copies of any item, mirroring the UI caps.
 */
export function smartSelect(
	candidates: PoolCandidate[],
	count = DECK_SIZE,
	opts: { maxEhb?: number | null; random?: boolean } = {}
): PoolCandidate[] {
	if (!candidates.length) return [];
	if (candidates.length >= count)
		return opts.random ? randomSelect(candidates, count) : autoSelect(candidates, count);

	const sorted = [...candidates].sort((a, b) => a.ehb - b.ehb);
	// Never manufacture past the max-EHB filter; with no max, past the dearest real tile.
	const hi = opts.maxEhb ?? sorted[sorted.length - 1].ehb;
	type Variant = { c: PoolCandidate; q: number; eff: number };
	const virtual: Variant[] = [];
	for (const c of sorted) {
		if (c.qty && c.qty > 1) {
			// A custom task with its own ×N keeps it — its EHB already describes the task.
			virtual.push({ c, q: c.qty, eff: c.ehb });
			continue;
		}
		for (let q = 1; q <= 9; q++) {
			const eff = c.ehb * q;
			if (q > 1 && eff > hi) break;
			virtual.push({ c, q, eff });
		}
	}
	virtual.sort((a, b) => a.eff - b.eff);

	const qtyOf = new Map<number, number>();
	const copiesOf = new Map<number, number>();
	const usable = (v: Variant) =>
		(qtyOf.get(v.c.item_id) ?? v.q) === v.q && (copiesOf.get(v.c.item_id) ?? 0) < 20;
	const picks: Variant[] = [];
	const band = virtual.length / count;
	for (let i = 0; i < count; i++) {
		const lo = Math.floor(i * band);
		const hiIdx = Math.max(lo, Math.min(virtual.length - 1, Math.ceil((i + 1) * band) - 1));
		const start = opts.random
			? lo + Math.floor(Math.random() * (hiIdx - lo + 1))
			: Math.min(hiIdx, Math.floor(i * band + band / 2));
		// Prefer the band; walk outward through the whole list if its entries clash with
		// an item's already-chosen drops value or copies cap.
		let pick: Variant | null = null;
		for (let d = 0; d < virtual.length && !pick; d++) {
			for (const j of [start + d, start - d]) {
				if (j >= 0 && j < virtual.length && usable(virtual[j])) {
					pick = virtual[j];
					break;
				}
			}
		}
		if (!pick) break; // 20 copies of everything and still short — genuinely impossible
		qtyOf.set(pick.c.item_id, pick.q);
		copiesOf.set(pick.c.item_id, (copiesOf.get(pick.c.item_id) ?? 0) + 1);
		picks.push(pick);
	}
	return picks.map((v) => ({ ...v.c, ...(v.q > 1 ? { qty: v.q } : { qty: undefined }) }));
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
