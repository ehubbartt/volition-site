// EXPERIMENTAL: builds src/lib/server/data/itemEhb.json — an "EHB per item" metric
// for the drop-difficulty admin tool (and, later, auto event generation).
//
//   ehbPerItem = expectedKills / bossEhbRate   (expected efficient bossing hours
//   to obtain the drop). expectedKills ≈ 1 / dropChancePerKill.
//
// Sources:
//   • Drop rates: pairofcrocs/drop-rates-clog  src/main/resources/com/dropratesclog/drop_rates.json
//   • EHB rates (kills/hr): WiseOldMan  server/src/api/modules/efficiency/configs/ehb/main.ehb.ts
//     (inlined in RATES below — refresh by hand if WOM updates them).
//
// Run from the repo root:  node db/scripts/build_item_ehb.mjs
// Requires network access to raw.githubusercontent.com.

import fs from 'node:fs';

const DROP_RATES_URL =
	'https://raw.githubusercontent.com/pairofcrocs/drop-rates-clog/master/src/main/resources/com/dropratesclog/drop_rates.json';
const ITEMS_PATH = 'src/lib/server/data/osrsItems.json';
const OUT_PATH = 'src/lib/server/data/itemEhb.json';

// WiseOldMan main-account EHB rates (kills/hr), keyed by the drop-rates-clog source
// display name (lowercased). Chest/variant aliases included where they differ.
const RATES = {
	'abyssal sire': 50, 'alchemical hydra': 30, 'amoxliatl': 85, 'araxxor': 40, 'artio': 60,
	'barrows': 22, 'chest (barrows)': 22, 'bryophyta': 9, 'callisto': 142, "calvar'ion": 55,
	'cerberus': 65, 'chambers of xeric': 3.5, 'chaos elemental': 120, 'chaos fanatic': 100,
	'commander zilyana': 60, 'corporeal beast': 60, 'crazy archaeologist': 75,
	'dagannoth prime': 105, 'dagannoth rex': 105, 'dagannoth supreme': 105,
	'deranged archaeologist': 80, 'doom of mokhaiotl': 20, 'duke sucellus': 39,
	'general graardor': 58, 'giant mole': 125, 'grotesque guardians': 37, 'hespori': 60,
	'kalphite queen': 55, 'king black dragon': 130, 'kraken': 100, "kree'arra": 40,
	"k'ril tsutsaroth": 65, 'lunar chest': 18, 'lunar chests': 18, 'mimic': 60, 'nex': 23.5,
	'the nightmare': 14, 'obor': 12, 'phantom muspah': 30, "phosani's nightmare": 9.6,
	'sarachnis': 110, 'scorpia': 130, 'scurrius': 70, 'shellbane gryphon': 95, 'skotizo': 45,
	'sol heredit': 2.7, 'spindel': 55, 'the hueycoatl': 20, 'the leviathan': 31,
	'the royal titans': 55, 'the whisperer': 22, 'theatre of blood': 3.2,
	'thermonuclear smoke devil': 150, 'tombs of amascut': 3.7, 'chest (tombs of amascut)': 3.7,
	'tzkal-zuk': 1, 'tztok-jad': 2.5, 'vardorvis': 39, 'venenatis': 80, "vet'ion": 50,
	'vorkath': 34, 'yama': 18, 'zulrah': 46,
	'reward chest (the gauntlet) (regular)': 10, 'reward chest (the gauntlet) (corrupted)': 7.2
};

const norm = (s) => s.toLowerCase().trim();

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
const items = JSON.parse(fs.readFileSync(ITEMS_PATH, 'utf8'));
const nameById = new Map(items.map((i) => [i.id, i.name]));

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
			const ehb = kills / ehbRate;
			if (!best || ehb < best.ehbPerItem) {
				best = {
					id: itemId, name, source: src, dropRate: e.rate,
					expectedKills: Math.round(kills * 100) / 100,
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
