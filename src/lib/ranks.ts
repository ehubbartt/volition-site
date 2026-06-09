// CLIENT-SAFE EHB rank metadata for the Volition roster. The bot's `players.rank`
// column stores a WOM role string (see voli-disc-bot/config/ranks.json); these are
// the same strings, in ladder order, with display labels + colors for the home
// page's rank breakdown. Keep in sync with the bot's ranks.json if it changes.

export const RANK_ORDER = [
	'bronze',
	'iron',
	'steel',
	'gold',
	'mithril',
	'adamant',
	'rune',
	'dragon',
	'sage',
	'legend',
	'myth',
	'tztok',
	'tzkal'
] as const;

export type RankValue = (typeof RANK_ORDER)[number];

export const RANK_LABEL: Record<RankValue, string> = {
	bronze: 'Bronze',
	iron: 'Iron',
	steel: 'Steel',
	gold: 'Gold',
	mithril: 'Mithril',
	adamant: 'Adamant',
	rune: 'Rune',
	dragon: 'Dragon',
	sage: 'Sage',
	legend: 'Legend',
	myth: 'Myth',
	tztok: 'TzTok',
	tzkal: 'TzKal'
};

export const RANK_COLOR: Record<RankValue, string> = {
	bronze: '#cd7f32',
	iron: '#8d8d8d',
	steel: '#9fb0c4',
	gold: '#ffcc33',
	mithril: '#4a6fd6',
	adamant: '#29a37a',
	rune: '#4aa6b5',
	dragon: '#d8531f',
	sage: '#7bbf6a',
	legend: '#b06bd6',
	myth: '#e0457b',
	tztok: '#ff7a18',
	tzkal: '#c0392b'
};

// Rank badge images live in static/ranks/ (served at /ranks/*). Capitalized
// filenames. Only `unranked` has no art → null (callers fall back to a color dot).
export const RANK_IMG: Record<RankValue, string | null> = {
	bronze: '/ranks/Bronze.webp',
	iron: '/ranks/Iron.webp',
	steel: '/ranks/Steel.webp',
	gold: '/ranks/Gold.webp',
	mithril: '/ranks/Mithril.webp',
	adamant: '/ranks/Adamant.webp',
	rune: '/ranks/Rune.webp',
	dragon: '/ranks/Dragon.webp',
	sage: '/ranks/Sage.webp',
	legend: '/ranks/Legend.webp',
	myth: '/ranks/Myth.webp',
	tztok: '/ranks/TzTok.webp',
	tzkal: '/ranks/TzKal.webp'
};

const UNRANKED_COLOR = '#9aa0a6';

function normalize(womRole: string | null | undefined): RankValue | null {
	if (!womRole) return null;
	const v = womRole.trim().toLowerCase();
	return (RANK_ORDER as readonly string[]).includes(v) ? (v as RankValue) : null;
}

// Ladder position (0 = lowest). Unknown / unranked sorts last (-1 → treated as the
// bottom for descending sorts; callers can special-case).
export function rankIndex(womRole: string | null | undefined): number {
	const v = normalize(womRole);
	return v ? RANK_ORDER.indexOf(v) : -1;
}

export function rankLabel(womRole: string | null | undefined): string {
	const v = normalize(womRole);
	return v ? RANK_LABEL[v] : 'Unranked';
}

export function rankColor(womRole: string | null | undefined): string {
	const v = normalize(womRole);
	return v ? RANK_COLOR[v] : UNRANKED_COLOR;
}

// Badge image for a rank, or null if there's no art for it (→ color-dot fallback).
export function rankImg(womRole: string | null | undefined): string | null {
	const v = normalize(womRole);
	return v ? RANK_IMG[v] : null;
}
