// CLIENT-SAFE Combat Achievement helpers for personal-bingo CA tiles — the CA analogue of
// ehb.ts / ehp.ts. Pure + dependency-free so both the server (board generator) and the page
// can tier / label / icon CA goals the same way.

export const CA_TIERS = ['easy', 'medium', 'hard', 'elite', 'master', 'grandmaster'] as const;
export type CaTier = (typeof CA_TIERS)[number];

// 'grandmaster' → 'Grandmaster'.
export function caTierLabel(tier: string | null | undefined): string {
	const t = (tier ?? '').trim();
	return t ? t.charAt(0).toUpperCase() + t.slice(1) : '';
}

// Target CA tier index (into CA_TIERS) for a board tile, by the difficulty dial (1–10) and the
// tile's band — mirrors the EHB/EHP gradient: difficulty 1 keeps every tile Easy; difficulty 10
// spreads Easy→Grandmaster across the board. The generator falls back outward to the nearest
// tier that still has an uncompleted CA, so an empty target tier never wastes a tile.
export function caTierForDifficulty(difficulty: number, band: number, bands: number): number {
	const d = Math.min(10, Math.max(1, difficulty));
	const ceiling = Math.round(((d - 1) / 9) * (CA_TIERS.length - 1)); // 0 (easy) .. 5 (grandmaster)
	const t = bands <= 1 ? 0 : band / (bands - 1);
	return Math.max(0, Math.min(ceiling, Math.round(t * ceiling)));
}

// OSRS Wiki tier-medal icon ("Combat Achievements - <Tier> tier icon.png"). The page hides it
// on a 404, and the tile always shows the tier label too, so the image is non-critical.
export function caTierIconUrl(tier: string | null | undefined): string {
	const t = (tier ?? 'easy').trim() || 'easy';
	const Tier = t.charAt(0).toUpperCase() + t.slice(1);
	return `https://oldschool.runescape.wiki/images/Combat_Achievements_-_${Tier}_tier_icon.png`;
}
