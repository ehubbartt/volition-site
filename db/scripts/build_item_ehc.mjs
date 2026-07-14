// Builds src/lib/server/data/itemEhc.json — the NON-BOSS collection-log item pool for
// personal bingo, valued by TempleOSRS's per-item EHC (efficient hours clogged).
//
// itemEhb.json (build_item_ehb.mjs) covers boss/raid drops with curated kill-rate math;
// this file covers everything else on the clog (clues, minigames, skilling activities,
// misc uniques) using Temple's EHC as the hours-to-obtain estimate. Items already in
// itemEhb.json are SKIPPED — boss items keep their curated EHB + admin overrides.
//
// Temple has NO public "all clog items" endpoint, so the catalogue is the UNION of a
// few deep players' logs (a player's log only lists slots they own). Pass the deepest
// clan logs you know:
//
//   node db/scripts/build_item_ehc.mjs --player=<rsn1>,<rsn2>,<rsn3> [--min=400] [--dump]
//
// Run from repo root (needs templeosrs.com — see https://templeosrs.com/api_doc.php,
// Collection log section). If the script aborts, it prints a bounded diagnostic of the
// actual response shape (top-level keys + two raw item objects + all item keys seen) —
// paste that back so the parser can be adapted precisely. --dump prints the same
// diagnostics even on success. It ABORTS (writes nothing) rather than committing a
// thin or EHC-less file.
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

const playerUrl = (rsn) =>
	`https://templeosrs.com/api/collection-log/player_collection_log.php?player=${encodeURIComponent(rsn)}&categories=all&includenames=1`;

// Accept several spellings of the EHC field; remember which key matched (reported in
// the summary so we know what Temple actually calls it).
const EHC_KEYS = ['ehc', 'Ehc', 'EHC', 'ehc_rate', 'ehcRate', 'ehc_hours'];
const matchedEhcKeys = new Set();
function readEhc(obj) {
	for (const k of EHC_KEYS) {
		const v = obj[k];
		if (v != null && Number.isFinite(Number(v))) {
			matchedEhcKeys.add(k);
			return Number(v);
		}
	}
	// Last resort: any key containing 'ehc' (case-insensitive) with a numeric value.
	for (const [k, v] of Object.entries(obj)) {
		if (/ehc/i.test(k) && v != null && Number.isFinite(Number(v))) {
			matchedEhcKeys.add(k);
			return Number(v);
		}
	}
	return null;
}

// Collect item-shaped objects ({name} + numeric id-ish field), remembering the nearest
// enclosing key as the category. The site consumes this endpoint as
// data.items = Record<category, item[]> (see fetchOwnedClogNames in personalBoard.ts),
// so we walk data.items explicitly when present and fall back to a recursive walk.
const itemKeysSeen = new Set();
function toItem(node, category) {
	const name = typeof node.name === 'string' ? node.name.trim() : null;
	const id = Number(node.id ?? node.item_id ?? node.itemId ?? NaN);
	if (!name || !Number.isFinite(id)) return null;
	for (const k of Object.keys(node)) itemKeysSeen.add(k);
	return { id, name, ehc: readEhc(node), category };
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
function parseResponse(json) {
	const out = [];
	const items = json?.data?.items;
	if (items && typeof items === 'object' && !Array.isArray(items)) {
		for (const [category, arr] of Object.entries(items)) collectItems(arr, category, out);
	}
	if (!out.length) collectItems(json, 'Uncategorised', out);
	return out;
}

// Bounded shape diagnostic — paste-able back if the parser needs adapting.
function dumpDiagnostics(rsn, json, parsed) {
	console.log(`--- diagnostics for ${rsn} ---`);
	console.log('top-level keys:', Object.keys(json ?? {}).join(', ') || '(none)');
	if (json?.data && typeof json.data === 'object') {
		console.log('data keys:', Object.keys(json.data).join(', '));
		const items = json.data.items;
		if (items && typeof items === 'object') {
			const cats = Object.keys(items);
			console.log(`data.items: ${Array.isArray(items) ? 'array' : `object with ${cats.length} keys`} — first: ${cats.slice(0, 5).join(', ')}`);
		}
	}
	// Two raw item-ish objects verbatim (from parse output positions, or a best-effort probe).
	const samples = [];
	(function probe(node) {
		if (samples.length >= 2) return;
		if (Array.isArray(node)) return node.forEach(probe);
		if (!node || typeof node !== 'object') return;
		if (typeof node.name === 'string') {
			samples.push(node);
			return;
		}
		Object.values(node).forEach(probe);
	})(json);
	for (const s of samples) console.log('raw item sample:', JSON.stringify(s));
	console.log('distinct item keys seen:', [...itemKeysSeen].join(', ') || '(none)');
	console.log(`parsed ${parsed.length} item-shaped entries, ${parsed.filter((i) => i.ehc != null).length} with an EHC value`);
	console.log('--- end diagnostics ---');
}

const ehbItems = JSON.parse(fs.readFileSync(EHB_PATH, 'utf8'));
const bossIds = new Set(ehbItems.map((i) => i.id));
const bossNames = new Set(ehbItems.map((i) => i.name.toLowerCase()));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Union across players: keep the lowest EHC per item id (cheapest way to the slot).
const byId = new Map();
let unionParsed = 0;
let anyDumped = false;
for (const rsn of players) {
	if (unionParsed > 0) await sleep(1000); // politeness between player fetches
	const url = playerUrl(rsn);
	let json = null;
	try {
		const res = await fetch(url, { headers: { 'User-Agent': 'Volition-Site build script' } });
		if (!res.ok) {
			console.warn(`skip ${rsn} — HTTP ${res.status}`);
			continue;
		}
		json = await res.json();
	} catch (e) {
		console.warn(`skip ${rsn} — ${e.message}`);
		continue;
	}
	const parsed = parseResponse(json);
	const withEhc = parsed.filter((i) => i.ehc != null).length;
	console.log(`${rsn}: ${parsed.length} items parsed, ${withEhc} with EHC`);
	unionParsed += parsed.length;
	if (DUMP || parsed.length === 0 || withEhc === 0) {
		dumpDiagnostics(rsn, json, parsed);
		anyDumped = true;
	}
	for (const it of parsed) {
		if (bossIds.has(it.id) || bossNames.has(it.name.toLowerCase())) continue;
		if (it.ehc == null || !(it.ehc > 0)) continue;
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
}

if (unionParsed < MIN_UNION) {
	console.error(
		`ABORT: union parsed only ${unionParsed} items (< --min=${MIN_UNION}). ` +
			'Add more/deeper players, or paste the diagnostics above back for a parser fix. Nothing was written.'
	);
	process.exit(1);
}

const out = [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
if (out.length < 200) {
	console.error(
		`ABORT: only ${out.length} usable non-boss items after filtering — the endpoint may not carry ` +
			'per-item EHC. Paste the diagnostics above back for a parser fix. Nothing was written.'
	);
	if (!anyDumped) console.error('(re-run with --dump for response-shape diagnostics)');
	process.exit(1);
}

fs.writeFileSync(OUT_PATH, JSON.stringify(out));
console.log(
	`Wrote ${out.length} items to ${OUT_PATH} (union of ${players.length} player log(s); ` +
		`EHC field: ${[...matchedEhcKeys].join(', ') || 'n/a'})`
);
