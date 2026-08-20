// CLIENT-SAFE OSRS Wiki image helpers — the ONE place that turns an item / skill / monster /
// CA-tier / arbitrary file name into a hotlinkable wiki image URL. Centralised so we stop
// re-deriving (and re-breaking) these URLs across components. All URLs are hotlinked straight
// from the browser (no server egress); render them through <WikiImage> (or set
// referrerpolicy="no-referrer" + an onerror fallback yourself) since the odd file 404s.
//
// Wiki file-name rules: the FIRST letter is upper-cased (the wiki always upper-cases it),
// spaces become underscores, apostrophes are %27-encoded, parentheses are kept. The rest of
// the name is CASE-SENSITIVE, which is the awkward part — see `wikiImageSources`.
//
// TWO THINGS BREAK A NAIVE URL, and both were silently blanking icons across the site:
//
//  1. `/images/<File>.png` is NOT where MediaWiki keeps files. They live in hash-bucketed
//     subdirectories (`/images/a/ab/<File>.png`), and the flat path only resolves for the
//     ones that happen to be served that way. `Special:FilePath/<File>.png` is the
//     canonical resolver — it 302s to wherever the file actually is, and it is a strict
//     superset of the flat path (every name the flat path resolved, this one does too).
//     It also takes `?width=`, so thumbnails come from the same place.
//
//  2. Only the first letter is case-normalised. Our item names come from the OSRS item
//     database in sentence case ("Staff of the dead", "Baby mole") while the wiki files
//     are title-cased ("Staff_of_the_Dead.png", "Baby_Mole.png"). There is no
//     case-insensitive lookup, so the fix is to offer BOTH spellings and let the image
//     element fall through — see `wikiImageSources` and `retryImage`.

export function wikiFileName(name: string): string {
	const s = name.trim();
	if (!s) return '';
	return (s.charAt(0).toUpperCase() + s.slice(1)).replace(/ /g, '_').replace(/'/g, '%27');
}

// Words the wiki leaves lowercase inside a title ("Staff of the Dead", "Claws of Callisto").
const MINOR_WORDS = new Set(['of', 'the', 'and', 'a', 'an', 'in', 'on', 'to', 'for', 'from', 'with', 'at', 'by']);

/**
 * The wiki's title-case spelling of a name — capitalised except for minor words, and
 * capitalised after hyphens too ("Remnant of Ba-Ba", "Jal-Nib-Rek").
 */
export function wikiTitleCase(name: string): string {
	const capParts = (w: string) =>
		w
			.split('-')
			.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
			.join('-');
	return name
		.trim()
		.split(' ')
		.map((w, i) => {
			const lower = w.toLowerCase();
			if (i > 0 && MINOR_WORDS.has(lower)) return lower;
			return capParts(w);
		})
		.join(' ');
}

const FILE_PATH = 'https://oldschool.runescape.wiki/w/Special:FilePath/';

// Full-size image. Returns '' for an empty name so callers can skip it.
export function wikiImageUrl(name: string): string {
	const file = wikiFileName(name);
	return file ? `${FILE_PATH}${file}.png` : '';
}

/**
 * Every spelling of a name worth trying, best first: the name as given, then the wiki's
 * title-cased form. `<WikiImage>` walks the list, so an item whose file is title-cased
 * resolves on the second try instead of rendering as a blank tile.
 */
export function wikiImageSources(name: string | null | undefined): string[] {
	const n = (name ?? '').trim();
	if (!n) return [];
	const out = [wikiImageUrl(n)];
	const titled = wikiImageUrl(wikiTitleCase(n));
	if (titled && titled !== out[0]) out.push(titled);
	return out;
}

// Wiki ARTICLE link (/w/<Page>) for a boss / skill / item / etc. Returns '' for an empty name.
export function wikiPageUrl(name: string | null | undefined): string {
	const n = (name ?? '').trim();
	return n ? `https://oldschool.runescape.wiki/w/${encodeURIComponent(n.replace(/ /g, '_'))}` : '';
}

// Thumbnail scaled to `width` px. Special:FilePath takes ?width= directly, so this needs
// no knowledge of the /thumb/ layout (which has the same hash-bucket problem as /images/).
export function wikiThumbUrl(name: string, width: number): string {
	const url = wikiImageUrl(name);
	return url ? `${url}?width=${Math.round(width)}` : '';
}

// Item inventory icon — the file is "<Item>.png", give or take the wiki's title casing.
export const itemImageUrl = (item: string): string[] => wikiImageSources(item);

// Skill icon — the file is "<Skill>_icon.png".
export const skillImageUrl = (skill: string): string[] => wikiImageSources(`${skill.trim()} icon`);

// Some "monster" values are raids, reward chests or groupings with no NPC image at
// "<name>.png"; map them to a representative image that does exist on the wiki. Names whose
// only problem is a trailing qualifier ("Vorkath (Post-quest)") need no entry here — see
// `stripQualifier` in `monsterImageNames`.
export const MONSTER_IMAGE_ALIASES: Record<string, string> = {
	'chambers of xeric': 'Great Olm',
	'chambers of xeric: challenge mode': 'Great Olm',
	'theatre of blood': 'Verzik Vitur',
	'theatre of blood: hard mode': 'Verzik Vitur',
	'tombs of amascut': "Tumeken's Warden",
	'tombs of amascut: expert mode': "Tumeken's Warden",
	'chest (tombs of amascut)': "Tumeken's Warden",
	// Bosses whose wiki file carries a form/phase qualifier the drop source doesn't.
	zulrah: 'Zulrah (serpentine)',
	'alchemical hydra': 'Alchemical Hydra (serpentine)',
	'phantom muspah': 'Phantom Muspah (ranged)',
	'grotesque guardians': 'Dusk',
	"phosani's nightmare": 'The Nightmare',
	// Reward chests named after the encounter rather than an NPC.
	'lunar chest': 'Blue Moon',
	'monumental chest': 'Doom of Mokhaiotl'
};

// A trailing "(...)" on a drop source is nearly always a variant tag Dink/the item DB adds
// ("Vorkath (Post-quest)", "Scurrius (MVP)", "Rewards Chest (Fortis Colosseum) (Wave 7)") —
// the wiki file is under the bare name. Strips ONE trailing group, so the nested case keeps
// its inner parentheses.
function stripQualifier(name: string): string {
	return name.replace(/\s*\([^()]*\)\s*$/, '').trim();
}

/**
 * Every name worth trying for a boss / drop source, best first: the alias if we have one,
 * the name as given, then the same two again with a trailing qualifier removed.
 */
function monsterImageNames(m: string): string[] {
	const out: string[] = [];
	const push = (n: string) => {
		if (n && !out.includes(n)) out.push(n);
	};
	const alias = (n: string) => MONSTER_IMAGE_ALIASES[n.toLowerCase()];

	push(alias(m) ?? m);
	const bare = stripQualifier(m);
	if (bare && bare !== m) push(alias(bare) ?? bare);
	return out;
}

// Boss / NPC image. Wiki NPC pages use "<Name>.png" as the primary image, so that convention
// resolves for the vast majority of bosses (with the alias map and the qualifier strip
// covering the exceptions).
export function monsterImageUrl(monster: string | null | undefined): string[] {
	const m = (monster ?? '').trim();
	if (!m) return [];
	const urls = monsterImageNames(m).flatMap((n) => wikiImageSources(n));
	return [...new Set(urls)];
}

// Combat-achievement tier medal ("Combat Achievements - <Tier> tier icon.png").
export function caTierImageUrl(tier: string | null | undefined): string[] {
	const t = (tier ?? 'easy').trim() || 'easy';
	return wikiImageSources(`Combat Achievements - ${t.charAt(0).toUpperCase() + t.slice(1)} tier icon`);
}

// Achievement-diary tile icon (region-agnostic — the wiki has no per-region icons).
// <WikiImage>'s onerror fallback covers a rename of this file on the wiki.
export function diaryImageUrl(): string[] {
	return wikiImageSources('Achievement Diaries icon');
}
