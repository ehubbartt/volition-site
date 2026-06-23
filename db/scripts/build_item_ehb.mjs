// EXPERIMENTAL: builds src/lib/server/data/itemEhb.json for the EHB drop tool.
//
// Instead of a single precomputed EHB, each item stores its qualifying drop
// SOURCES with a mechanic tag + raw numbers, so the tool computes EHB live from
// editable assumptions (raid purple rates, ToA invocation, Doom floor):
//   kill:  ehb = expectedKills / killsPerHour
//   raid:  ehb = tableShareKills / perRaidPurpleRate / raidsPerHour   (cox/toa/tobn/tobh)
//   doom:  ehb = (1 / perFloorRate[floor][col]) / clearsPerHour
//
// Sources:
//   • Drop rates: pairofcrocs/drop-rates-clog  drop_rates.json
//   • EHB rates (kills/hr): WiseOldMan IRONMAN configs/ehb/ironman.ehb.ts (inlined)
//   • Item names: RuneLite cache names.json (current every game update)
//   • Doom per-floor rates: Speaax/Delve-calculator DelveCalculatorPlugin.java (inlined)
//
// Run from repo root:  node db/scripts/build_item_ehb.mjs   (needs raw.githubusercontent.com)

const DROP_RATES_URL =
	'https://raw.githubusercontent.com/pairofcrocs/drop-rates-clog/master/src/main/resources/com/dropratesclog/drop_rates.json';
const ITEM_NAMES_URL =
	'https://raw.githubusercontent.com/runelite/static.runelite.net/master/cache/item/names.json';
const OUT_PATH = 'src/lib/server/data/itemEhb.json';

import fs from 'node:fs';

// Flat per-kill boss rates (kills/hr), keyed by the clog source name (lowercased).
// Raids (CoX/ToB/ToA) and Doom are handled separately below — NOT here.
const KILL_RATES = {
	'abyssal sire': 44, 'alchemical hydra': 29, 'amoxliatl': 71, 'araxxor': 38, 'artio': 50,
	'barrows': 22, 'chest (barrows)': 22, 'bryophyta': 9, 'callisto': 142, "calvar'ion": 45,
	'cerberus': 54, 'chaos elemental': 48, 'chaos fanatic': 80, 'commander zilyana': 30,
	'corporeal beast': 10, 'crazy archaeologist': 95, 'dagannoth prime': 100, 'dagannoth rex': 100,
	'dagannoth supreme': 100, 'deranged archaeologist': 95, 'duke sucellus': 37,
	'general graardor': 31, 'giant mole': 97, 'grotesque guardians': 34, 'hespori': 50,
	'kalphite queen': 37, 'king black dragon': 75, 'kraken': 90, "kree'arra": 30,
	"k'ril tsutsaroth": 32, 'lunar chest': 18, 'mimic': 50, 'nex': 20, 'the nightmare': 11,
	'obor': 12, 'phantom muspah': 27, "phosani's nightmare": 9.3, 'sarachnis': 67, 'scorpia': 80,
	'scurrius': 60, 'shellbane gryphon': 95, 'skotizo': 38, 'sol heredit': 2.7,
	'rewards chest (fortis colosseum)': 2.7, 'spindel': 50, 'the hueycoatl': 20,
	'the leviathan': 27, 'the royal titans': 55, 'the whisperer': 21,
	'thermonuclear smoke devil': 100, 'tzkal-zuk': 1, 'tztok-jad': 2.2, 'vardorvis': 37,
	'venenatis': 80, "vet'ion": 39, 'vorkath': 34, 'yama': 18, 'zulrah': 42,
	'reward chest (the gauntlet) (regular)': 10, 'reward chest (the gauntlet) (corrupted)': 7.2
};

// Doom of Mokhaiotl per-floor, per-kill rates (from the Delve calculator). Columns:
// cloth / eye (Eye of ayak) / treads (Avernic) / dom (pet). 0 = doesn't drop at that floor.
const DOOM_FLOORS = {
	2: { cloth: 1 / 2500, eye: 0, treads: 0, dom: 0 },
	3: { cloth: 1 / 1000, eye: 1 / 2000, treads: 0, dom: 0 },
	4: { cloth: 1 / 450, eye: 1 / 1350, treads: 1 / 1350, dom: 0 },
	5: { cloth: 1 / 270, eye: 1 / 810, treads: 1 / 810, dom: 0 },
	6: { cloth: 1 / 255, eye: 1 / 765, treads: 1 / 765, dom: 1 / 1000 },
	7: { cloth: 1 / 240, eye: 1 / 720, treads: 1 / 720, dom: 1 / 750 },
	8: { cloth: 1 / 210, eye: 1 / 630, treads: 1 / 630, dom: 1 / 500 },
	9: { cloth: 1 / 180, eye: 1 / 540, treads: 1 / 540, dom: 1 / 250 } // "8+" deep delve
};
// Map a Doom unique's item name → which floor-rate column it uses.
function doomColumn(name) {
	const n = name.toLowerCase();
	if (n.includes('mokhaiotl cloth')) return 'cloth';
	if (n.includes('eye of ayak')) return 'eye';
	if (n.includes('avernic treads')) return 'treads';
	if (n === 'dom') return 'dom';
	return null;
}

const norm = (s) => s.toLowerCase().trim();

// Alternate-acquisition sources that aren't the boss kill (so items are costed by
// their real drop, e.g. Oathplate helm = 1/600 @ Yama, not "Always @ Yama (Contract)").
const EXCLUDE_SOURCE = /contract|lockbox|dossier|reward pool|infected root|nightmare zone/i;

// "a/b", commas, decimals, "N × a/b", "Always" → expected kills (1 / per-kill chance).
// For raid chests this yields the inverse of the purple-table share (expected purples).
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

// Classify a source → { t, r? } where t is the mechanic. null = not EHB-trackable.
function classify(src) {
	if (EXCLUDE_SOURCE.test(src)) return null;
	const n = norm(src);
	if (n === 'ancient chest') return { t: 'cox', r: 3.5 }; // Chambers of Xeric reward chest
	if (n === 'monumental chest (normal mode)') return { t: 'tobn', r: 3.2 };
	if (n === 'monumental chest (hard mode)') return { t: 'tobh', r: 3 };
	if (n.startsWith('chest (tombs of amascut)')) return { t: 'toa', r: n.includes('expert') ? 3 : 3.7 };
	if (n === 'doom of mokhaiotl') return { t: 'doom' };
	if (KILL_RATES[n] != null) return { t: 'kill', r: KILL_RATES[n] };
	const stripped = n.replace(/\s*\([^()]*\)\s*$/, '').trim(); // "Yama (Contract)" already excluded
	if (stripped !== n && KILL_RATES[stripped] != null) return { t: 'kill', r: KILL_RATES[stripped] };
	return null;
}

const dropRates = await (await fetch(DROP_RATES_URL)).json();
const namesObj = await (await fetch(ITEM_NAMES_URL)).json();
const nameById = new Map(Object.entries(namesObj).map(([id, name]) => [Number(id), name]));

const out = [];
for (const [id, entries] of Object.entries(dropRates)) {
	const itemId = Number(id);
	const name = nameById.get(itemId);
	if (!name) continue;

	const sources = [];
	const seen = new Set();
	for (const e of entries) {
		if (e.kind && e.kind !== 'drop') continue;
		const kills = expectedKills(e.rate || '');
		for (const src of e.sources || []) {
			const c = classify(src);
			if (!c) continue;
			if (c.t === 'doom') {
				const col = doomColumn(name);
				if (!col) continue; // only the 4 modelled Doom uniques use per-floor rates
				if (seen.has('doom')) continue;
				seen.add('doom');
				sources.push({ s: src, t: 'doom', col });
				continue;
			}
			if (kills == null) continue;
			const key = `${c.t}:${src}`;
			if (seen.has(key)) continue;
			seen.add(key);
			sources.push({ s: src, t: c.t, k: Math.round(kills * 100) / 100, r: c.r, rate: e.rate });
		}
	}
	if (sources.length) out.push({ id: itemId, name, sources });
}
out.sort((a, b) => a.name.localeCompare(b.name));
fs.writeFileSync(OUT_PATH, JSON.stringify(out));
console.log(`Wrote ${out.length} items to ${OUT_PATH}`);
