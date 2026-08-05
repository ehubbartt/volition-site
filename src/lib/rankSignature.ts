// CLIENT-SAFE metadata + math for SIGNATURE RANKS — a prestige layer that sits ON TOP of
// the composite clan rank. They aren't scored from the weighted composite; they're earned
// by FULLY COMPLETING whole rank categories (a category is "complete" when its bar hits
// 100% — raw >= cap). Owning multiple maxed categories is the flex these ranks show off.
//
// The three tiers reward 5, 6, and 7 completed categories out of the seven scored ones
// (Gear, EHB, Combat achievements, Time in clan, Collection log, Total level, Volition TCG).
// Working names below are PLACEHOLDERS — rename freely; only the `required` counts and the
// image paths are load-bearing. Icons live in static/ranks/ like the other rank badges.

export interface SignatureTier {
	key: string; // stable id
	required: number; // completed categories needed to earn this tier
	label: string; // display name (placeholder — rename)
	blurb: string; // one-line "what it means"
	img: string | null; // /ranks/*.webp badge (null until the art is wired)
	color: string; // accent for the badge label / progress
}

// Highest tier last. `required` must be strictly increasing. Badge art lives in
// static/ranks/ (like the other rank icons); the files are wired once supplied — the UI
// falls back to a coloured badge until then, so a missing file never breaks the page.
export const SIGNATURE_TIERS: SignatureTier[] = [
	{
		key: 'savant',
		required: 5,
		label: 'Savant',
		blurb: 'Five of the seven clan categories fully completed.',
		img: '/ranks/Savant.webp',
		color: '#d9a441'
	},
	{
		key: 'curator',
		required: 6,
		label: 'Curator',
		blurb: 'Six of the seven clan categories fully completed.',
		img: '/ranks/Curator.webp',
		color: '#7bbf6a'
	},
	{
		key: 'paragon',
		required: 7,
		label: 'Paragon',
		blurb: 'Every clan category maxed — total clan completion.',
		img: '/ranks/Paragon.webp',
		color: '#9fb0c4'
	}
];

// The smallest tier threshold — below this a member has no signature rank.
export const SIGNATURE_MIN_REQUIRED = Math.min(...SIGNATURE_TIERS.map((t) => t.required));

// A single scored category, as the Rank tab already models it (normalized 0..1 with its
// raw/cap). A category counts as COMPLETE when its bar is maxed — raw met the cap.
export interface CategoryProgress {
	key: string;
	label: string;
	raw: number;
	cap: number;
	normalized: number;
}

// Complete = the bar is full: a positive cap the raw value has reached. Mirrors the
// `.maxed` styling in RankPanel so "green/maxed" and "counts for a signature rank" agree.
export function isCategoryComplete(c: { raw: number; cap: number }): boolean {
	return c.cap > 0 && c.raw >= c.cap;
}

export function completedCategoryCount(categories: CategoryProgress[]): number {
	return categories.filter(isCategoryComplete).length;
}

// The highest signature tier a member has earned for `completed` maxed categories, or null.
export function earnedSignatureTier(completed: number): SignatureTier | null {
	let earned: SignatureTier | null = null;
	for (const t of SIGNATURE_TIERS) if (completed >= t.required) earned = t;
	return earned;
}

// The next signature tier still to earn (for the "progress toward" display), or null when
// the top tier is already held.
export function nextSignatureTier(completed: number): SignatureTier | null {
	return SIGNATURE_TIERS.find((t) => completed < t.required) ?? null;
}
