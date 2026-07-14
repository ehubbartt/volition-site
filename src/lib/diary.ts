// CLIENT-SAFE Achievement Diary helpers for personal-bingo diary tiles — the diary
// analogue of ca.ts. Pure + dependency-free so both the server (board generator) and
// the page can tier / label / link diary goals the same way.
//
// The catalogue is static: 12 regions × 4 tiers, matching the keys WikiSync reports
// under `achievement_diaries` (region names and Title-case tier names). If Jagex ever
// adds a region, extend DIARY_REGIONS here — nothing else needs to change.

export const DIARY_REGIONS = [
	'Ardougne',
	'Desert',
	'Falador',
	'Fremennik',
	'Kandarin',
	'Karamja',
	'Kourend & Kebos',
	'Lumbridge & Draynor',
	'Morytania',
	'Varrock',
	'Western Provinces',
	'Wilderness'
] as const;
export type DiaryRegion = (typeof DIARY_REGIONS)[number];

export const DIARY_TIERS = ['Easy', 'Medium', 'Hard', 'Elite'] as const;
export type DiaryTier = (typeof DIARY_TIERS)[number];

// Canonical key for a (region, tier) pair — used for WikiSync completion sets and
// tile triggers. Tier is stored Title-case as WikiSync reports it.
export function diaryKey(region: string, tier: string): string {
	return `${region}|${tier}`;
}

export function diaryLabel(region: string, tier: string): string {
	return `${region} ${tier}`;
}

// The wiki article for every diary is "<Region> Diary".
export function diaryWikiPage(region: string): string {
	return `${region} Diary`;
}

// Rough hours-to-complete estimates per tier, used ONLY to band tiles by the board's
// difficulty dial and to weight VP-relevant EHB totals. These assume the skill/quest
// requirements are already met — tune freely.
const DIARY_BASE_HOURS: Record<DiaryTier, number> = {
	Easy: 0.75,
	Medium: 1.5,
	Hard: 3,
	Elite: 6
};

// Per-region outliers on top of the base table (notably long or short tiers).
const DIARY_HOUR_TWEAKS: Partial<Record<DiaryRegion, Partial<Record<DiaryTier, number>>>> = {
	Karamja: { Easy: 0.3 },
	'Lumbridge & Draynor': { Easy: 0.3 },
	Fremennik: { Elite: 8 },
	Desert: { Elite: 8 },
	'Western Provinces': { Elite: 12 },
	Wilderness: { Elite: 8 }
};

export function diaryHours(region: string, tier: string): number {
	const t = tier as DiaryTier;
	const tweak = DIARY_HOUR_TWEAKS[region as DiaryRegion]?.[t];
	return tweak ?? DIARY_BASE_HOURS[t] ?? 1;
}

// Target diary tier index (into DIARY_TIERS) for a board tile, by the difficulty dial
// (1–10) and the tile's band — same shape as caTierForDifficulty: difficulty 1 keeps
// every tile Easy; difficulty 10 spreads Easy→Elite across the board. The generator
// falls back outward to the nearest tier with an uncompleted diary.
export function diaryTierForDifficulty(difficulty: number, band: number, bands: number): number {
	const d = Math.min(10, Math.max(1, difficulty));
	const ceiling = Math.round(((d - 1) / 9) * (DIARY_TIERS.length - 1)); // 0 (Easy) .. 3 (Elite)
	const t = bands <= 1 ? 0 : band / (bands - 1);
	return Math.max(0, Math.min(ceiling, Math.round(t * ceiling)));
}
