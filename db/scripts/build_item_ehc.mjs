// Builds src/lib/server/data/itemEhc.json — the NON-BOSS collection-log item pool for
// personal bingo, valued by TempleOSRS's per-item EHC (efficient hours clogged).
//
// itemEhb.json (build_item_ehb.mjs) covers boss/raid drops with curated kill-rate math;
// this file covers everything else on the clog (clues, minigames, skilling activities,
// misc uniques) using Temple's EHC as the hours-to-obtain estimate. Items already in
// itemEhb.json are SKIPPED — boss items keep their curated EHB + admin overrides.
//
// Run from repo root (needs templeosrs.com — check endpoints against
// https://templeosrs.com/api_doc.php, Collection log section):
//
//   node db/scripts/build_item_ehc.mjs [--player=<synced RSN>]
//
// Endpoint strategy (defensive — Temple's shapes have shifted before):
//   1. Try catalogue-style endpoints that describe every clog item with an EHC value.
//   2. Fall back to a synced player's full collection log (categories=all with
//      unowned slots included), which carries per-item EHC fields; pass --player=
//      with a well-synced account (their log defines the catalogue we see).
// The parser walks the response for item-shaped objects ({id, name} + an EHC-ish key)
// and records the category they sit under. It ABORTS (writes nothing) if fewer than
// SANITY_MIN items parse — never commit a truncated file.
//
// Output shape (consumed by personalBoard.ts):
//   [{ "id": 13226, "name": "Herbi", "ehc": 31.5, "category": "All Pets", "pet": true }, ...]

import fs from 'node:fs';

const OUT_PATH = 'src/lib/server/data/itemEhc.json';
const EHB_PATH = 'src/lib/server/data/itemEhb.json';
const SANITY_MIN = 800; // full clog is ~1500+ slots; fewer parsed = something broke

const playerArg = process.argv.find((a) => a.startsWith('--player='))?.slice('--player='.length);

// Candidate endpoints, tried in order. The player log is the reliable fallback: with
// categories=all it enumerates every slot (count 0 for unowned) grouped by category.
const CANDIDATES = [
	'https://templeosrs.com/api/collection-log/items.php',
	'https://templeosrs.com/api/collection-log/categories.php?includenames=1',
	...(playerArg
		? [
				`https://templeosrs.com/api/collection-log/player_collection_log.php?player=${encodeURIComponent(playerArg)}&categories=all&includenames=1&onlyitems=0`
			]
		: [])
];

// Accept several spellings of the EHC field.
function readEhc(obj) {
	for (const k of ['ehc', 'Ehc', 'EHC', 'ehc_rate', 'ehcRate', 'ehc_hours']) {
		const v = obj[k];
		if (v != null && Number.isFinite(Number(v))) return Number(v);
	}
	return null;
}

// Recursively collect item-shaped objects, remembering the nearest enclosing key as
// the category (Temple groups player logs as items[<category>] = [...]).
function collectItems(node, category, out) {
	if (Array.isArray(node)) {
		for (const v of node) collectItems(v, category, out);
		return;
	}
	if (!node || typeof node !== 'object') return;
	const name = typeof node.name === 'string' ? node.name.trim() : null;
	const id = Number(node.id ?? node.item_id ?? NaN);
	if (name && Number.isFinite(id)) {
		out.push({ id, name, ehc: readEhc(node), category });
		return;
	}
	for (const [k, v] of Object.entries(node)) collectItems(v, k, out);
}

const ehbItems = JSON.parse(fs.readFileSync(EHB_PATH, 'utf8'));
const bossIds = new Set(ehbItems.map((i) => i.id));
const bossNames = new Set(ehbItems.map((i) => i.name.toLowerCase()));

let parsed = null;
let fromUrl = null;
for (const url of CANDIDATES) {
	try {
		const res = await fetch(url, { headers: { 'User-Agent': 'Volition-Site build script' } });
		if (!res.ok) {
			console.warn(`skip ${url} — HTTP ${res.status}`);
			continue;
		}
		const json = await res.json();
		const found = [];
		collectItems(json, 'Uncategorised', found);
		if (found.length >= SANITY_MIN) {
			parsed = found;
			fromUrl = url;
			break;
		}
		console.warn(`skip ${url} — only ${found.length} item-shaped entries`);
	} catch (e) {
		console.warn(`skip ${url} — ${e.message}`);
	}
}

if (!parsed) {
	console.error(
		`ABORT: no endpoint yielded >= ${SANITY_MIN} items.` +
			(playerArg ? '' : ' Try again with --player=<a well-synced RSN>.') +
			' Nothing was written.'
	);
	process.exit(1);
}

// Dedupe by id (keep the lowest EHC — the cheapest way to obtain the slot), skip boss
// items and anything without a usable EHC.
const byId = new Map();
let noEhc = 0;
for (const it of parsed) {
	if (bossIds.has(it.id) || bossNames.has(it.name.toLowerCase())) continue;
	if (it.ehc == null || !(it.ehc > 0)) {
		noEhc++;
		continue;
	}
	const prev = byId.get(it.id);
	if (!prev || it.ehc < prev.ehc) {
		byId.set(it.id, {
			id: it.id,
			name: it.name,
			ehc: Math.round(it.ehc * 100) / 100,
			category: it.category,
			...(/pets?/i.test(it.category) ? { pet: true } : {})
		});
	}
}

const out = [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
if (out.length < 200) {
	console.error(
		`ABORT: only ${out.length} usable non-boss items after filtering ` +
			`(${noEhc} lacked an EHC value — the endpoint may not carry per-item EHC). Nothing was written.`
	);
	process.exit(1);
}

fs.writeFileSync(OUT_PATH, JSON.stringify(out));
console.log(`Wrote ${out.length} items to ${OUT_PATH} (source: ${fromUrl}; ${noEhc} skipped without EHC)`);
