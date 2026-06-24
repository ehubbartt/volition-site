// SERVER-ONLY WiseOldMan API v2 client (public API, no key) — mirrors the bot's
// womApi (voli-disc-bot/utils/api.js): base https://api.wiseoldman.net/v2 with a
// User-Agent header. Used by the on-site Skill or Kill leaderboard to read the same
// competition standings the bot shows in Discord.

import { getJson } from './http';

const WOM_BASE = 'https://api.wiseoldman.net/v2';

export interface WomParticipation {
	player: { displayName: string };
	progress: { gained: number };
}

export interface WomCompetition {
	id: number;
	title: string;
	metric: string;
	startsAt: string;
	endsAt: string;
	participations: WomParticipation[];
}

// Fetch one competition's details + standings. Best-effort: returns null on any
// network/parse error so a WOM outage degrades to "standings unavailable" rather
// than breaking the page.
export async function fetchCompetition(womId: number | string): Promise<WomCompetition | null> {
	return getJson<WomCompetition>(`${WOM_BASE}/competitions/${womId}`);
}

// The 24 OSRS skill metrics (incl. overall). Everything else WOM exposes as a
// competition metric (bosses, activities, computed) counts as a kill/score total.
const OSRS_SKILLS = new Set([
	'overall', 'attack', 'defence', 'strength', 'hitpoints', 'ranged', 'prayer', 'magic',
	'cooking', 'woodcutting', 'fletching', 'fishing', 'firemaking', 'crafting', 'smithing',
	'mining', 'herblore', 'agility', 'thieving', 'slayer', 'farming', 'runecrafting',
	'hunter', 'construction'
]);

export function metricKind(metric: string): 'skill' | 'boss' {
	return OSRS_SKILLS.has(metric) ? 'skill' : 'boss';
}

// 'dks' → 'Dks', 'chambers_of_xeric' → 'Chambers Of Xeric'. WOM metrics are
// lowercase snake_case; this is a readable fallback label.
export function metricLabel(metric: string): string {
	return (metric || '')
		.split('_')
		.filter(Boolean)
		.map((w) => w.charAt(0).toUpperCase() + w.slice(1))
		.join(' ');
}
