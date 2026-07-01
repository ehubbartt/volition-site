// CLIENT-SAFE OSRS Wiki image helpers — the ONE place that turns an item / skill / monster /
// CA-tier / arbitrary file name into a hotlinkable wiki image URL. Centralised so we stop
// re-deriving (and re-breaking) these URLs across components. All URLs are hotlinked straight
// from the browser (no server egress); render them through <WikiImage> (or set
// referrerpolicy="no-referrer" + an onerror fallback yourself) since the odd file 404s.
//
// Wiki file-name rules: the FIRST letter is upper-cased (the wiki always upper-cases it),
// spaces become underscores, apostrophes are %27-encoded, parentheses are kept. The rest of
// the name is CASE-SENSITIVE, so pass names in their canonical wiki casing — e.g. the monster
// "Shellbane gryphon" (sentence case), not "Shellbane Gryphon".

export function wikiFileName(name: string): string {
	const s = name.trim();
	if (!s) return '';
	return (s.charAt(0).toUpperCase() + s.slice(1)).replace(/ /g, '_').replace(/'/g, '%27');
}

// Full-size image: /images/<File>.png. Returns '' for an empty name so callers can skip it.
export function wikiImageUrl(name: string): string {
	const file = wikiFileName(name);
	return file ? `https://oldschool.runescape.wiki/images/${file}.png` : '';
}

// Wiki ARTICLE link (/w/<Page>) for a boss / skill / item / etc. Returns '' for an empty name.
export function wikiPageUrl(name: string | null | undefined): string {
	const n = (name ?? '').trim();
	return n ? `https://oldschool.runescape.wiki/w/${encodeURIComponent(n.replace(/ /g, '_'))}` : '';
}

// Thumbnail scaled to `width` px: /images/thumb/<File>.png/<width>px-<File>.png. Handy for the
// large boss/scene renders used on event boards (the cache-busting ?hash suffix is optional).
export function wikiThumbUrl(name: string, width: number): string {
	const file = wikiFileName(name);
	if (!file) return '';
	return `https://oldschool.runescape.wiki/images/thumb/${file}.png/${Math.round(width)}px-${file}.png`;
}

// Item inventory icon — the file is just "<Item>.png".
export const itemImageUrl = (item: string): string => wikiImageUrl(item);

// Skill icon — the file is "<Skill>_icon.png".
export const skillImageUrl = (skill: string): string => wikiImageUrl(`${skill.trim()} icon`);

// A few CA "monster" values are raids / groupings with no single NPC image at "<name>.png";
// map them to a representative boss image that does exist on the wiki.
export const MONSTER_IMAGE_ALIASES: Record<string, string> = {
	'chambers of xeric': 'Great Olm',
	'chambers of xeric: challenge mode': 'Great Olm',
	'theatre of blood': 'Verzik Vitur',
	'theatre of blood: hard mode': 'Verzik Vitur',
	'tombs of amascut': "Tumeken's Warden",
	'tombs of amascut: expert mode': "Tumeken's Warden"
};

// Boss / NPC image. Wiki NPC pages use "<Name>.png" as the primary image, so that convention
// resolves for the vast majority of bosses (with the alias map covering the exceptions).
export function monsterImageUrl(monster: string | null | undefined): string {
	const m = (monster ?? '').trim();
	if (!m) return '';
	return wikiImageUrl(MONSTER_IMAGE_ALIASES[m.toLowerCase()] ?? m);
}

// Combat-achievement tier medal ("Combat Achievements - <Tier> tier icon.png").
export function caTierImageUrl(tier: string | null | undefined): string {
	const t = (tier ?? 'easy').trim() || 'easy';
	return wikiImageUrl(`Combat Achievements - ${t.charAt(0).toUpperCase() + t.slice(1)} tier icon`);
}
