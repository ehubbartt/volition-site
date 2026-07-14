// Builds src/lib/server/data/itemEhc.json — the NON-BOSS collection-log item pool for
// personal bingo, valued by TempleOSRS's per-item EHC (efficient hours clogged).
//
// itemEhb.json (build_item_ehb.mjs) covers boss/raid drops with curated kill-rate math;
// this file covers everything else on the clog (clues, minigames, skilling activities,
// misc uniques) using Temple's per-item hours as the hours-to-obtain estimate. Items
// already in itemEhb.json are SKIPPED — boss items keep their curated EHB + overrides.
//
// Temple splits the data across TWO endpoints (see https://templeosrs.com/api_doc.php,
// Collection log section), so we fetch both per player and join on item id:
//
//   player_collection_log.php?player=<rsn>&categories=all&includenames=1
//     → the CATALOGUE: data.items = Record<category, {id, name, ...}[]>. Only lists
//       slots the player owns, and carries NO per-item hours.
//   player_collections.php?player=<rsn>
//     → the VALUES: data.items = Record<itemId, {count, item_date, hours} |
//       {count: 0, item_date: null, missing_hours}>. missing_hours is Temple's
//       estimated hours-to-obtain for a slot the player still lacks (preferred);
//       owned slots carry `hours` instead (often 0). No names or categories.
//
// The catalogue is the UNION of the given players' logs and the value per item is the
// MAX across players (a fresh account's missing_hours is the fullest estimate). Pass
// BOTH a fresh-ish account (rich missing_hours) and deep logs (full catalogue), e.g.:
//
//   node db/scripts/build_item_ehc.mjs --player=bajj,marni,Bazilijus [--min=400] [--dump]
//
// Semantics caveat: Temple's per-item hours are the item's marginal contribution toward
// completing its category, not a standalone grind estimate (each Barrows piece ≈ 0.66h;
// common clue uniques ≈ 0.003h). Within-category ranking is sound; /admin/ehb
// pin/exclude is the correction lever for anything that bands oddly. Items whose value
// is absent or <= 0 are skipped (real data contains zero AND negative missing_hours).
//
// Run from repo root. If the script aborts, it prints a bounded diagnostic of the
// actual response shape (top-level keys + two raw entries) — paste that back so the
// parser can be adapted precisely. --dump prints the same diagnostics even on success.
// It ABORTS (writes nothing) rather than committing a thin or value-less file.
//
// Output shape (consumed by personalBoard.ts):
//   [{ "id": 13226, "name": "Herbi", "ehc": 31.5, "category": "All Pets", "pet": true }, ...]

import fs from 'node:fs';

const OUT_PATH = 'src/lib/server/data/itemEhc.json';
const EHB_PATH = 'src/lib/server/data/itemEhb.json';

const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const players = (arg('player') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const MIN_UNION = Number(arg('min')) || 400; // union sanity floor (full clog is ~1500+ slots)
const DUMP = process.argv.includes('--dump');

if (!players.length) {
	console.error('Usage: node db/scripts/build_item_ehc.mjs --player=<rsn1>,<rsn2>,... [--min=400] [--dump]');
	process.exit(1);
}

const catalogueUrl = (rsn) =>
	`https://templeosrs.com/api/collection-log/player_collection_log.php?player=${encodeURIComponent(rsn)}&categories=all&includenames=1`;
const valuesUrl = (rsn) =>
	`https://templeosrs.com/api/collection-log/player_collections.php?player=${encodeURIComponent(rsn)}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let requestCount = 0;
async function fetchJson(rsn, url) {
	if (requestCount++ > 0) await sleep(1000); // politeness between ALL Temple requests
	const res = await fetch(url, { headers: { 'User-Agent': 'Volition-Site build script' } });
	if (!res.ok) throw new Error(`HTTP ${res.status}`);
	const text = await res.text();
	try {
		return JSON.parse(text);
	} catch {
		// Cloudflare challenges and error pages come back as HTML with a 200.
		throw new Error(`non-JSON response (Cloudflare challenge?): ${text.slice(0, 120).replace(/\s+/g, ' ')}`);
	}
}

// --- catalogue endpoint: category → items with id + name ------------------------------

// Collect item-shaped objects ({name} + numeric id-ish field), remembering the nearest
// enclosing key as the category. The site consumes this endpoint as
// data.items = Record<category, item[]> (see fetchOwnedClogNames in personalBoard.ts),
// so we walk data.items explicitly when present and fall back to a recursive walk.
function toItem(node, category) {
	const name = typeof node.name === 'string' ? node.name.trim() : null;
	const id = Number(node.id ?? node.item_id ?? node.itemId ?? NaN);
	if (!name || !Number.isFinite(id)) return null;
	return { id, name, category };
}
function collectItems(node, category, out) {
	if (Array.isArray(node)) {
		for (const v of node) collectItems(v, category, out);
		return;
	}
	if (!node || typeof node !== 'object') return;
	const item = toItem(node, category);
	if (item) {
		out.push(item);
		return;
	}
	for (const [k, v] of Object.entries(node)) collectItems(v, k, out);
}
function parseCatalogue(json) {
	const out = [];
	const items = json?.data?.items;
	if (items && typeof items === 'object' && !Array.isArray(items)) {
		for (const [category, arr] of Object.entries(items)) collectItems(arr, category, out);
	}
	if (!out.length) collectItems(json, 'Uncategorised', out);
	return out;
}

// --- values endpoint: item id → hours --------------------------------------------------

// missing_hours (slot not owned — Temple's estimate to obtain it) is preferred over
// hours (owned slots, usually 0). Returns Map<id, number>; non-finite values dropped.
const matchedValueKeys = new Set();
function parseValues(json) {
	const out = new Map();
	const items = json?.data?.items;
	if (!items || typeof items !== 'object' || Array.isArray(items)) return out;
	for (const [idStr, entry] of Object.entries(items)) {
		const id = Number(idStr);
		if (!Number.isFinite(id) || !entry || typeof entry !== 'object') continue;
		const key = entry.missing_hours != null ? 'missing_hours' : entry.hours != null ? 'hours' : null;
		if (!key) continue;
		const v = Number(entry[key]);
		if (!Number.isFinite(v)) continue;
		matchedValueKeys.add(key);
		out.set(id, v);
	}
	return out;
}

// Bounded shape diagnostic — paste-able back if a parser needs adapting.
function dumpDiagnostics(label, json, parsedCount) {
	console.log(`--- diagnostics for ${label} ---`);
	console.log('top-level keys:', Object.keys(json ?? {}).join(', ') || '(none)');
	if (json?.data && typeof json.data === 'object') {
		console.log('data keys:', Object.keys(json.data).join(', '));
		const items = json.data.items;
		if (items && typeof items === 'object') {
			const keys = Object.keys(items);
			console.log(`data.items: ${Array.isArray(items) ? 'array' : `object with ${keys.length} keys`} — first: ${keys.slice(0, 5).join(', ')}`);
			if (!Array.isArray(items)) {
				for (const [k, v] of Object.entries(items).slice(0, 2)) {
					console.log(`raw entry ${JSON.stringify(k)}:`, JSON.stringify(v).slice(0, 300));
				}
			}
		}
	}
	console.log(`parsed ${parsedCount} entries`);
	console.log('--- end diagnostics ---');
}

const ehbItems = JSON.parse(fs.readFileSync(EHB_PATH, 'utf8'));
const bossIds = new Set(ehbItems.map((i) => i.id));
const bossNames = new Set(ehbItems.map((i) => i.name.toLowerCase()));

// Union across players: first name/category seen per id; MAX value per id.
const catalogue = new Map(); // id → {id, name, category}
const values = new Map(); // id → hours
let unionParsed = 0;
let anyDumped = false;
for (const rsn of players) {
	let catJson = null;
	let valJson = null;
	try {
		catJson = await fetchJson(rsn, catalogueUrl(rsn));
		valJson = await fetchJson(rsn, valuesUrl(rsn));
	} catch (e) {
		console.warn(`skip ${rsn} — ${e.message}`);
		continue;
	}
	const catRows = parseCatalogue(catJson);
	const valRows = parseValues(valJson);
	console.log(`${rsn}: ${catRows.length} catalogue items, ${valRows.size} valued items`);
	unionParsed += catRows.length;
	if (DUMP || catRows.length === 0 || valRows.size === 0) {
		dumpDiagnostics(`${rsn} (catalogue)`, catJson, catRows.length);
		dumpDiagnostics(`${rsn} (values)`, valJson, valRows.size);
		anyDumped = true;
	}
	for (const it of catRows) {
		if (!catalogue.has(it.id)) catalogue.set(it.id, it);
	}
	for (const [id, v] of valRows) {
		const prev = values.get(id);
		if (prev == null || v > prev) values.set(id, v);
	}
}

if (unionParsed < MIN_UNION) {
	console.error(
		`ABORT: union parsed only ${unionParsed} catalogue items (< --min=${MIN_UNION}). ` +
			'Add more/deeper players, or paste the diagnostics above back for a parser fix. Nothing was written.'
	);
	process.exit(1);
}

const out = [];
for (const it of catalogue.values()) {
	if (bossIds.has(it.id) || bossNames.has(it.name.toLowerCase())) continue;
	const v = values.get(it.id);
	if (v == null || !(v > 0)) continue; // strictly positive — real data has 0 AND negative missing_hours
	out.push({
		id: it.id,
		name: it.name,
		ehc: Math.round(v * 100) / 100,
		category: it.category,
		...(/pets?/i.test(it.category) ? { pet: true } : {})
	});
}
out.sort((a, b) => a.name.localeCompare(b.name));

if (out.length < 200) {
	console.error(
		`ABORT: only ${out.length} usable non-boss items after filtering — too few valued slots. ` +
			'Add a fresh-ish account (rich missing_hours) alongside the deep logs, or paste the ' +
			'diagnostics above back for a parser fix. Nothing was written.'
	);
	if (!anyDumped) console.error('(re-run with --dump for response-shape diagnostics)');
	process.exit(1);
}

fs.writeFileSync(OUT_PATH, JSON.stringify(out));
console.log(
	`Wrote ${out.length} items to ${OUT_PATH} (union of ${players.length} player log(s); ` +
		`value fields seen: ${[...matchedValueKeys].join(', ') || 'n/a'})`
);
