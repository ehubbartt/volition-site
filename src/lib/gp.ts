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
