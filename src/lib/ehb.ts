// CLIENT-SAFE EHB (Efficient Hours Bossed) math for collection-log drops. Extracted
// from the admin EHB tool (src/routes/admin/ehb/+page.svelte) so the admin lookup AND
// the personal-bingo generator compute item difficulty the same way. Pure functions
// over the itemEhb.json dataset — no data import here (callers pass items in), so this
// stays client-safe and dependency-free.

export type EhbMechanic = 'kill' | 'cox' | 'tobn' | 'tobh' | 'toa' | 'doom';

export interface EhbSource {
	s: string; // source display name (boss / chest)
	t: EhbMechanic;
	k?: number; // expected kills/raids for the drop (1 / per-kill chance)
	r?: number; // kills/raids per hour (WiseOldMan ironman EHB rate)
	rate?: string; // raw drop-rate string, for display
	col?: 'cloth' | 'eye' | 'treads' | 'dom'; // doom per-floor column
}

export interface ItemEhb {
	id: number;
	name: string;
	sources: EhbSource[];
}

// Tunable assumptions (raid purple shares, doom floor/clears-per-hour, efficiency).
// Defaults mirror the admin tool's initial state.
export interface EhbAssumptions {
	coxN: number;
	tobnN: number;
	tobhN: number;
	toaN: number;
	doomFloor: number;
	doomKph: number;
	effMult: number;
}

export const DEFAULT_EHB_ASSUMPTIONS: EhbAssumptions = {
	coxN: 28.7, // CoX purple ≈ 1/28.7
	tobnN: 9.1, // ToB normal ≈ 1/9.1
	tobhN: 8.6, // ToB hard ≈ 1/8.6
	toaN: 13.6, // ToA ≈ 1/13.6 at 300 invocation
	doomFloor: 8,
	doomKph: 18,
	effMult: 1
};

// Doom of Mokhaiotl per-floor, per-kill unique rates (from the Delve calculator).
export const DOOM_FLOORS: Record<number, Record<string, number>> = {
	2: { cloth: 1 / 2500, eye: 0, treads: 0, dom: 0 },
	3: { cloth: 1 / 1000, eye: 1 / 2000, treads: 0, dom: 0 },
	4: { cloth: 1 / 450, eye: 1 / 1350, treads: 1 / 1350, dom: 0 },
	5: { cloth: 1 / 270, eye: 1 / 810, treads: 1 / 810, dom: 0 },
	6: { cloth: 1 / 255, eye: 1 / 765, treads: 1 / 765, dom: 1 / 1000 },
	7: { cloth: 1 / 240, eye: 1 / 720, treads: 1 / 720, dom: 1 / 750 },
	8: { cloth: 1 / 210, eye: 1 / 630, treads: 1 / 630, dom: 1 / 500 },
	9: { cloth: 1 / 180, eye: 1 / 540, treads: 1 / 540, dom: 1 / 250 }
};

// Admin-set manual corrections layered on top of the computed values (EHB is an estimate).
//   bossRate: key `${t}|${s}` → kills/raids per hour, replacing EhbSource.r for that boss.
//   itemEhb:  ItemEhb.id → a direct final EHB (hours) that wins outright for that item.
// Stored in vs_ehb_overrides; loaded by src/lib/server/ehbOverrides.ts and passed in here
// (keeping this lib DB-free), exactly like the assumptions.
export interface EhbOverrides {
	bossRate: Record<string, number>;
	itemEhb: Record<number, number>;
}

// Key for a boss-rate override — the (mechanic, source) pair that identifies a boss.
export function bossKey(src: EhbSource): string {
	return `${src.t}|${src.s}`;
}

// Max-efficiency EHB (hours) for one source. null = not computable. A boss-rate override
// substitutes for the source's `r` (doesn't apply to doom, which uses doomKph).
export function rawEhb(
	src: EhbSource,
	a: EhbAssumptions = DEFAULT_EHB_ASSUMPTIONS,
	o?: EhbOverrides
): number | null {
	const r = o?.bossRate[bossKey(src)] ?? src.r;
	switch (src.t) {
		case 'kill':
			return src.k != null && r ? src.k / r : null;
		case 'cox':
			return src.k != null && r ? (src.k * a.coxN) / r : null;
		case 'tobn':
			return src.k != null && r ? (src.k * a.tobnN) / r : null;
		case 'tobh':
			return src.k != null && r ? (src.k * a.tobhN) / r : null;
		case 'toa':
			return src.k != null && r ? (src.k * a.toaN) / r : null;
		case 'doom': {
			const rate = DOOM_FLOORS[a.doomFloor]?.[src.col ?? ''] ?? 0;
			return rate > 0 ? 1 / rate / a.doomKph : null;
		}
		default:
			return null;
	}
}

export function ehbOf(
	src: EhbSource,
	a: EhbAssumptions = DEFAULT_EHB_ASSUMPTIONS,
	o?: EhbOverrides
): number | null {
	const base = rawEhb(src, a, o);
	return base == null ? null : base * a.effMult;
}

// The cheapest (fastest) EHB to obtain an item across all its sources, plus the source
// that achieves it. A per-item override wins outright (still reporting the cheapest source
// for display). null when no source is computable.
export function bestEhbSource(
	item: { id?: number; sources: EhbSource[] },
	a: EhbAssumptions = DEFAULT_EHB_ASSUMPTIONS,
	o?: EhbOverrides
): { ehb: number; src: EhbSource; overridden?: boolean } | null {
	let best: { ehb: number; src: EhbSource } | null = null;
	for (const src of item.sources) {
		const ehb = ehbOf(src, a, o);
		if (ehb == null || !isFinite(ehb)) continue;
		if (!best || ehb < best.ehb) best = { ehb, src };
	}
	const itemOverride = item.id != null ? o?.itemEhb[item.id] : undefined;
	if (itemOverride != null && isFinite(itemOverride)) {
		// Keep the cheapest source for display context; report the override as the EHB.
		return { ehb: itemOverride, src: best?.src ?? item.sources[0], overridden: true };
	}
	return best;
}

export function bestEhb(
	item: { id?: number; sources: EhbSource[] },
	a: EhbAssumptions = DEFAULT_EHB_ASSUMPTIONS,
	o?: EhbOverrides
): number | null {
	return bestEhbSource(item, a, o)?.ehb ?? null;
}

// Human-readable hours, e.g. "45 min", "3.20 h", "120 h".
export function formatEhb(h: number): string {
	if (h < 1) return `${Math.round(h * 60)} min`;
	return `${h.toFixed(h < 10 ? 2 : 1)} h`;
}
