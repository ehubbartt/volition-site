// CLIENT-SAFE GP helpers shared by the admin wallet/stats panels (migrated from
// volition-admin-dashboard). ITEM_PRICES is the approximate GP value of each loot-crate
// reward item, used to total up the value sitting unpaid in players' wallets.

export const ITEM_PRICES: Record<string, number> = {
	'Abyssal Whip': 1_300_000,
	"Elidinis' Ward": 3_800_000,
	Bond: 15_000_000,
	'25M GP': 25_000_000,
	'Dragon Claws': 50_000_000,
	'100M GP': 100_000_000,
	'Twisted Bow': 1_400_000_000
};

export function itemPrice(name: string): number {
	return ITEM_PRICES[name] ?? 0;
}

// Compact GP formatting (e.g. 1_400_000_000 → "1.4B").
export function formatGP(gp: number): string {
	if (gp >= 1_000_000_000) return `${(gp / 1_000_000_000).toFixed(1)}B`;
	if (gp >= 1_000_000) return `${(gp / 1_000_000).toFixed(1)}M`;
	if (gp >= 1_000) return `${(gp / 1_000).toFixed(0)}K`;
	return String(gp);
}

// Percentage formatter shared by the stats/sim pages. With one arg, `n` is treated
// as a 0–1 fraction (0.25 → "25.0%"); with `total`, it's `n / total` (3, 12 → "25.0%").
// Consolidates the two divergent `pct()` copies that took different argument shapes.
export function formatPct(n: number, total?: number, digits = 1): string {
	const frac = total === undefined ? n : total === 0 ? 0 : n / total;
	return `${(frac * 100).toFixed(digits)}%`;
}

// OSRS quantity colour tier: the game tints stacked values yellow under 100k,
// white under 10M, and green at 10M+. Returns the class to apply to the number.
export function osrsTier(value: number): 't-k' | 't-m' | 't-b' {
	const v = Math.abs(Number(value) || 0);
	if (v >= 10_000_000) return 't-b';
	if (v >= 100_000) return 't-m';
	return 't-k';
}
