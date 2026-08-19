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
// PASS A THIN ACCOUNT. The value of an item comes from a player who LACKS it; a player who
// owns it reports `hours: 0`. The values endpoint returns the WHOLE catalogue (~1712 ids)
// for any player, so one low-log account supplies real hours for nearly everything, while
// the deep logs supply the names and categories (the catalogue endpoint lists only slots
// the player owns). Deep logs alone is how this file was last built, and it cost every
// item those accounts all owned — see the valuing section below.
//
// Semantics caveat: Temple's per-item hours are the item's marginal contribution toward
// completing its category, not a standalone grind estimate (each Barrows piece ≈ 0.66h;
// common clue uniques ≈ 0.003h). Within-category ranking is sound; /admin/ehb
// pin/exclude is the correction lever for anything that bands oddly. An item with no
// positive value anywhere in the union is KEPT at a nominal floor rather than dropped, and
// the count is reported.
//
// Run from repo root. If the script aborts, it prints a bounded diagnostic of the
// actual response shape (top-level keys + two raw entries) — paste that back so the
// parser can be adapted precisely. --dump prints the same diagnostics even on success.
// It ABORTS (writes nothing) rather than committing a thin or value-less file — including
// when any listed player fails outright. HTTP 429/5xx are retried with backoff first
// (Retry-After when sane, else 15s/30s/60s); other errors (bad RSN, Cloudflare HTML) abort
// immediately.
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
const DELAY_MS = Number(arg('delay')) || 2500;

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
const MAX_RETRIES = 3; // 429/5xx only — waits 15s/30s/60s (or Retry-After when sane)
async function fetchJson(rsn, url) {
	for (let attempt = 0; ; attempt++) {
		// Politeness between ALL Temple requests. 1s draws Cloudflare challenges (an HTML body
		// where JSON is expected, which aborts the run); 2.5s does not. --delay overrides.
		if (requestCount++ > 0) await sleep(DELAY_MS);
		const res = await fetch(url, { headers: { 'User-Agent': 'Volition-Site build script' } });
		if ((res.status === 429 || res.status >= 500) && attempt < MAX_RETRIES) {
			const retryAfter = Number(res.headers.get('retry-after'));
			const waitS =
				Number.isFinite(retryAfter) && retryAfter > 0 && retryAfter < 300
					? Math.ceil(retryAfter)
					: 15 * 2 ** attempt;
			console.warn(`${rsn}: HTTP ${res.status} — waiting ${waitS}s, retry ${attempt + 1}/${MAX_RETRIES}`);
			await sleep(waitS * 1000);
			continue;
		}
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		const text = await res.text();
		try {
			return JSON.parse(text);
		} catch {
			// Cloudflare challenges and error pages come back as HTML with a 200.
			throw new Error(`non-JSON response (Cloudflare challenge?): ${text.slice(0, 120).replace(/\s+/g, ' ')}`);
		}
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
		// A silently partial union contradicts the abort-over-thin-data rule above.
		console.error(`ABORT: ${rsn} failed (${e.message}). Fix the RSN or wait out the rate limit and re-run. Nothing was written.`);
		process.exit(1);
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

// ── Valuing the catalogue ────────────────────────────────────────────────────
//
// An item is worth `missing_hours` from a player who LACKS it. A player who OWNS it
// reports `hours: 0` — Temple has nothing to estimate. So an item every sampled player
// owns has no positive value anywhere in the union.
//
// This used to be a `continue`, and it silently gutted the file. Deep-log accounts own
// nearly every hard/elite/master clue unique, so those tiers were cut to the handful of
// leftovers one account still lacked: `hard_treasure_trails` kept 11 items that overlap by
// ZERO with what players actually pull from hard clues, and every grouped clue tile on
// those tiers became impossible to complete. (See docs/EVENTS.md; the tiles themselves no
// longer depend on this file, but individual item tiles still do.)
//
// So: never drop a catalogued item for want of a value — keep it at a nominal floor.
//
// The floor is deliberately NEAR ZERO rather than "the cheapest known value in the
// category". Temple really does answer `missing_hours: 0` for these, even to a player who
// lacks them: they are marginal-zero toward completing their category. Inventing a
// mid-range value instead would misprice 124 hard-clue items at 2.78h each, and
// `minTileEhb` would then wave them onto mid and high difficulty boards — measured, that
// took clue items from 21% to 51% of the eligible pool at difficulty 5. Pricing them at
// what Temple actually said keeps them where they belong: eligible on the easiest boards,
// last in every gradient, and correctable per item via /admin/ehb.
//
// The count is reported per category, because a large fallback count can ALSO mean the
// player mix is wrong — a thin account's missing_hours covers nearly the whole catalogue,
// so anything still unvalued after including one is genuinely valueless to Temple.
const FALLBACK_FLOOR = 0.01;

const out = [];
const fallbackByCategory = new Map();
for (const it of catalogue.values()) {
	if (bossIds.has(it.id) || bossNames.has(it.name.toLowerCase())) continue;
	let v = values.get(it.id);
	if (v == null || !(v > 0)) {
		v = FALLBACK_FLOOR;
		fallbackByCategory.set(it.category, (fallbackByCategory.get(it.category) ?? 0) + 1);
	}
	out.push({
		id: it.id,
		name: it.name,
		ehc: Math.round(v * 100) / 100,
		category: it.category,
		...(/pets?/i.test(it.category) ? { pet: true } : {})
	});
}
out.sort((a, b) => a.name.localeCompare(b.name));

// Per-category census, so a tier collapsing to a handful of items is impossible to miss.
const perCategory = new Map();
for (const i of out) perCategory.set(i.category, (perCategory.get(i.category) ?? 0) + 1);
const totalFallback = [...fallbackByCategory.values()].reduce((s, n) => s + n, 0);
console.log(`\n${out.length} non-boss items across ${perCategory.size} categories`);
if (totalFallback) {
	console.log(
		`${totalFallback} of them are valued at 0 by Temple itself (no positive missing_hours ` +
			`anywhere in the union) and were kept at the ${FALLBACK_FLOOR}h floor:`
	);
	for (const [cat, n] of [...fallbackByCategory].sort((a, b) => b[1] - a[1]).slice(0, 12)) {
		console.log(`   ${String(n).padStart(4)}  ${cat}`);
	}
	if (totalFallback > out.length / 3) {
		console.log(
			'\nNOTE: a third or more of the pool is estimated. Add a THIN account to --player ' +
				'(its missing_hours covers nearly the whole catalogue) and re-run for real values.'
		);
	}
}

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
	`Wrote ${out.length} items to ${OUT_PATH} (union of ${players.length} player log(s): ${players.join(', ')}; ` +
		`value fields seen: ${[...matchedValueKeys].join(', ') || 'n/a'})`
);
