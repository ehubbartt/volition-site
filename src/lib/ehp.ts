// CLIENT-SAFE EHP (Efficient Hours Played) helpers for skilling bingo tiles — the skilling
// analogue of ehb.ts. Pure + dependency-free so both the server (personal-board generator)
// and the page can size/format skill goals the same way.

export const SKILLS = [
	'Attack', 'Strength', 'Defence', 'Hitpoints', 'Ranged', 'Prayer', 'Magic', 'Runecraft',
	'Construction', 'Agility', 'Herblore', 'Thieving', 'Crafting', 'Fletching', 'Slayer',
	'Hunter', 'Mining', 'Smithing', 'Fishing', 'Cooking', 'Firemaking', 'Woodcutting', 'Farming'
] as const;
export type Skill = (typeof SKILLS)[number];

// Combat skills that are NOT offered as skilling bingo tiles (they're covered by PvM/CA tiles
// instead). Prayer is deliberately kept — it's the one combat skill that's a pure grind tile.
export const NON_TILE_SKILLS: ReadonlySet<Skill> = new Set([
	'Attack', 'Strength', 'Defence', 'Hitpoints', 'Ranged', 'Magic'
]);

// The skills a personal-board skilling tile can be drawn from (everything except the combat
// skills above, i.e. Prayer + all non-combat skills).
export const TILE_SKILLS: readonly Skill[] = SKILLS.filter((s) => !NON_TILE_SKILLS.has(s));

// WiseOldMan metric key per skill (lowercase; the only odd one is Runecraft → 'runecrafting').
export const SKILL_WOM_KEY: Record<Skill, string> = Object.fromEntries(
	SKILLS.map((s) => [s, s === 'Runecraft' ? 'runecrafting' : s.toLowerCase()])
) as Record<Skill, string>;

// Representative ironman max-efficiency XP/hour per skill (the EHP analogue of EHB's per-boss
// rate). Approximate + tunable — used only to size a tile's XP goal from a target number of
// efficient hours, so exact values aren't critical. A later pass could use level-bracketed
// rates or admin overrides (mirroring the EHB overrides).
export const SKILL_EHP_RATES: Record<Skill, number> = {
	Attack: 350_000, Strength: 350_000, Defence: 350_000, Hitpoints: 350_000,
	Ranged: 380_000, Prayer: 500_000, Magic: 400_000, Runecraft: 55_000,
	Construction: 500_000, Agility: 65_000, Herblore: 450_000, Thieving: 260_000,
	Crafting: 380_000, Fletching: 520_000, Slayer: 95_000, Hunter: 220_000,
	Mining: 80_000, Smithing: 350_000, Fishing: 70_000, Cooking: 500_000,
	Firemaking: 320_000, Woodcutting: 100_000, Farming: 600_000
};

// Round an XP figure to a clean number (no "gain 275,346 xp"): a nice step by magnitude.
export function roundXp(xp: number): number {
	if (xp <= 0) return 0;
	let step: number;
	if (xp < 50_000) step = 5_000;
	else if (xp < 250_000) step = 10_000;
	else if (xp < 1_000_000) step = 25_000;
	else if (xp < 5_000_000) step = 100_000;
	else step = 250_000;
	return Math.max(step, Math.round(xp / step) * step);
}

// OSRS Wiki skill icon (every skill's icon file is `<Skill>_icon.png`). Re-exported from the
// shared $lib/wikiImage module so all wiki-image URL logic lives in one place.
export { skillImageUrl as skillIconUrl } from '$lib/wikiImage';

// "250K XP" / "1.2M XP".
export function formatXp(xp: number): string {
	if (xp >= 1_000_000) {
		const m = xp / 1_000_000;
		return `${Number.isInteger(m) ? m : m.toFixed(1)}M XP`;
	}
	if (xp >= 1000) return `${Math.round(xp / 1000)}K XP`;
	return `${Math.round(xp)} XP`;
}

// Target efficient-hours for a skill tile, by the difficulty dial (1–10) and the tile's band
// (so a board still runs easy→hard), with a little jitter for variety. The XP goal is then
// hours × the skill's EHP rate, rounded.
export function skillTileHours(difficulty: number, band: number, bands: number): number {
	const d = Math.min(10, Math.max(1, difficulty));
	const hi = 0.5 + d * 0.85; // ceiling EHP-hours at this difficulty (d=1 ≈ 1.35h, d=10 ≈ 9h)
	const lo = hi * 0.12; // easiest tile on the board
	const t = bands <= 1 ? 0.5 : band / (bands - 1);
	const base = lo + (hi - lo) * t;
	const jitter = 0.85 + Math.random() * 0.3; // ±15%
	return Math.max(0.1, base * jitter);
}
