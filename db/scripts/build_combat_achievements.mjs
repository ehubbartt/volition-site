// Builds src/lib/server/data/caTasks.json — the committed offline seed for personal-bingo
// Combat Achievement tiles (id → name → tier).
//
// The OSRS Wiki's "bucket" API is the canonical source: it returns every combat achievement's
// id, name and tier, where `id` is the SAME 0-based id space WikiSync reports as completed
// (rankData.fetchWikiSyncCA) and that rankScoring/combatAchievements.json already tiers. New
// CAs are appended at the end of that id space and never renumber existing ones.
//
// At runtime src/lib/server/caNames.ts refreshes from this same API, so this committed file is
// only an offline seed/fallback — re-run this when you want the bundled snapshot to include the
// latest CAs (e.g. after a CA batch release):
//
//   node db/scripts/build_combat_achievements.mjs     (needs oldschool.runescape.wiki)
//
// If the wiki is unreachable from where you run it (e.g. a sandboxed CI), the existing
// committed file is left untouched.

import fs from 'node:fs';

const WIKI_BUCKET_URL =
	'https://oldschool.runescape.wiki/api.php?action=bucket&format=json&query=' +
	encodeURIComponent('bucket("combat_achievement").select("id","name","tier").limit(5000).run()');
const USER_AGENT = 'Volition-Site personal-bingo build (github.com/ehubbartt/volition-site)';
const OUT_PATH = 'src/lib/server/data/caTasks.json';

const res = await fetch(WIKI_BUCKET_URL, { headers: { 'User-Agent': USER_AGENT } });
if (!res.ok) {
	console.error(`Wiki bucket request failed: ${res.status} ${res.statusText} — leaving ${OUT_PATH} untouched`);
	process.exit(1);
}
const { bucket } = await res.json();
if (!Array.isArray(bucket) || !bucket.length) {
	console.error('Wiki bucket returned no rows — leaving output untouched');
	process.exit(1);
}

// The bucket query is id/name/tier only (the field set proven by public rank tools). The boss
// image comes from the committed `monster` field, so preserve it by id across regenerations;
// brand-new CAs land with monster=null until one is filled in by hand.
let prevMonster = new Map();
try {
	const prev = JSON.parse(fs.readFileSync(OUT_PATH, 'utf8'));
	prevMonster = new Map(prev.map((t) => [t.id, t.monster ?? null]));
} catch {
	/* no existing file — fine */
}

const out = [];
for (const row of bucket) {
	if (typeof row.id !== 'number' || !row.name || !row.tier) continue;
	out.push({
		id: row.id,
		name: String(row.name),
		tier: String(row.tier).toLowerCase(),
		monster: prevMonster.get(row.id) ?? null
	});
}
out.sort((a, b) => a.id - b.id);

fs.writeFileSync(OUT_PATH, JSON.stringify(out, null, 0) + '\n');
const named = out.filter((t) => t.monster).length;
console.log(`Wrote ${out.length} combat achievements to ${OUT_PATH} (${named} with a boss image)`);
