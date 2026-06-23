// EXPERIMENTAL: builds src/lib/server/data/itemEhb.json — an "EHB per item" metric
// for the drop-difficulty admin tool (and, later, auto event generation).
//
//   ehbPerItem = expectedKills / bossEhbRate   (expected efficient bossing hours
//   to obtain the drop). expectedKills ≈ 1 / dropChancePerKill.
//
// Sources:
//   • Drop rates: pairofcrocs/drop-rates-clog  src/main/resources/com/dropratesclog/drop_rates.json
//   • EHB rates (kills/hr): WiseOldMan  server/src/api/modules/efficiency/configs/ehb/ironman.ehb.ts
//     (IRONMAN rates — inlined in RATES below; refresh by hand if WOM updates them).
//   • Item id→name: RuneLite cache names.json (current every game update, so even
//     brand-new items like Oathplate/Avernic resolve).
//
// Run from the repo root:  node db/scripts/build_item_ehb.mjs
// Requires network access to raw.githubusercontent.com.

import fs from 'node:fs';

const DROP_RATES_URL =
	'https://raw.githubusercontent.com/pairofcrocs/drop-rates-clog/master/src/main/resources/com/dropratesclog/drop_rates.json';
const ITEM_NAMES_URL =
	'https://raw.githubusercontent.com/runelite/static.runelite.net/master/cache/item/names.json';
const OUT_PATH = 'src/lib/server/data/itemEhb.json';

// WiseOldMan IRONMAN EHB rates (kills/hr), keyed by the drop-rates-clog source
// display name (lowercased). Chest/variant aliases included where they differ
// (the matcher also strips one trailing "(...)", e.g. "Yama (Contract)" → "yama").
const RATES = {
	'abyssal sire': 44, 'alchemical hydra': 29, 'amoxliatl': 71, 'araxxor': 38, 'artio': 50,
	'barrows': 22, 'chest (barrows)': 22, 'bryophyta': 9, 'callisto': 142, "calvar'ion": 45,
	'cerberus': 54, 'chambers of xeric': 3.5, 'chaos elemental': 48, 'chaos fanatic': 80,
	'commander zilyana': 30, 'corporeal beast': 10, 'crazy archaeologist': 95,
	'dagannoth prime': 100, 'dagannoth rex': 100, 'dagannoth supreme': 100,
	'deranged archaeologist': 95, 'doom of mokhaiotl': 18, 'duke sucellus': 37,
	'general graardor': 31, 'giant mole': 97, 'grotesque guardians': 34, 'hespori': 50,
	'kalphite queen': 37, 'king black dragon': 75, 'kraken': 90, "kree'arra": 30,
	"k'ril tsutsaroth": 32, 'lunar chest': 18, 'lunar chests': 18, 'mimic': 50, 'nex': 20,
	'the nightmare': 11, 'obor': 12, 'phantom muspah': 27, "phosani's nightmare": 9.3,
	'sarachnis': 67, 'scorpia': 80, 'scurrius': 60, 'shellbane gryphon': 95, 'skotizo': 38,
	'sol heredit': 2.7, 'rewards chest (fortis colosseum)': 2.7, 'spindel': 50,
	'the hueycoatl': 20, 'the leviathan': 27, 'the royal titans': 55, 'the whisperer': 21,
	'theatre of blood': 3.2, 'thermonuclear smoke devil': 100, 'tombs of amascut': 3.7,
	'chest (tombs of amascut)': 3.7, 'chest (tombs of amascut) (expert mode)': 3,
	'tzkal-zuk': 1, 'tztok-jad': 2.2, 'vardorvis': 37,
	'venenatis': 80, "vet'ion": 39, 'vorkath': 34, 'yama': 18, 'zulrah': 42,
	'reward chest (the gauntlet) (regular)': 10, 'reward chest (the gauntlet) (corrupted)': 7.2,
	// Raid reward chests (the clog data attributes raid uniques to these):
	'ancient chest': 3.5, // Chambers of Xeric
	'monumental chest (normal mode)': 3.2, // Theatre of Blood
	'monumental chest (hard mode)': 3 // Theatre of Blood: Hard Mode
};

// CoX & ToB list raid uniques as a share of the PURPLE/unique table (e.g. tbow
// "2/69"), NOT a per-raid chance — you don't get a purple every raid. Multiply
// expected items by 1/(per-raid purple chance) to get expected raids. These purple
// rates are points/invocation-dependent; representative averages used here.
// (ToA & Gauntlet roll each unique per-completion, so they need no gate.)
const PURPLE_RATE = {
	'ancient chest': 1 / 28.7, // Chambers of Xeric (~typical points)
	'monumental chest (normal mode)': 1 / 9.1, // Theatre of Blood
	'monumental chest (hard mode)': 1 / 8.6 // Theatre of Blood: Hard Mode
};

const norm = (s) => s.toLowerCase().trim();

function purpleFactor(src) {
	const r = PURPLE_RATE[norm(src)];
	return r ? 1 / r : 1;
}

function rateForSource(src) {
	const n = norm(src);
	if (RATES[n] != null) return RATES[n];
	const stripped = n.replace(/\s*\([^()]*\)\s*$/, '').trim(); // "Yama (Contract)" → "yama"
	if (stripped !== n && RATES[stripped] != null) return RATES[stripped];
	return null;
}

// "a/b", commas, decimals, "N × a/b" (N rolls/kill), "Always" → expected kills.
function expectedKills(rate) {
	if (/always/i.test(rate)) return 1;
	const cleaned = rate.replace(/,/g, '');
	const mult = cleaned.match(/^\s*(\d+)\s*[×x]\s*/);
	const n = mult ? Number(mult[1]) : 1;
	const frac = cleaned.match(/(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)/);
	if (!frac) return null;
	const a = Number(frac[1]);
	const b = Number(frac[2]);
	if (!a || !b) return null;
	const prob = Math.min(1, (n * a) / b);
	return prob > 0 ? 1 / prob : null;
}

const dropRates = await (await fetch(DROP_RATES_URL)).json();
const namesObj = await (await fetch(ITEM_NAMES_URL)).json(); // { "<id>": "Name", ... }
const nameById = new Map(Object.entries(namesObj).map(([id, name]) => [Number(id), name]));

const out = [];
for (const [id, entries] of Object.entries(dropRates)) {
	const itemId = Number(id);
	const name = nameById.get(itemId);
	if (!name) continue;
	let best = null;
	for (const e of entries) {
		if (e.kind && e.kind !== 'drop') continue;
		const kills = expectedKills(e.rate || '');
		if (kills == null) continue;
		for (const src of e.sources || []) {
			const ehbRate = rateForSource(src);
			if (ehbRate == null) continue;
			const effKills = kills * purpleFactor(src); // expected kills/raids incl. purple gate
			const ehb = effKills / ehbRate;
			if (!best || ehb < best.ehbPerItem) {
				best = {
					id: itemId, name, source: src, dropRate: e.rate,
					expectedKills: Math.round(effKills * 100) / 100,
					ehbRate, ehbPerItem: Math.round(ehb * 1000) / 1000, approx: !!e.approx
				};
			}
		}
	}
	if (best) out.push(best);
}
out.sort((a, b) => a.ehbPerItem - b.ehbPerItem);
fs.writeFileSync(OUT_PATH, JSON.stringify(out));
console.log(`Wrote ${out.length} items to ${OUT_PATH}`);
