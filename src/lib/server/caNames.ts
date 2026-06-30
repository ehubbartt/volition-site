// SERVER-ONLY: Combat Achievement id → name → tier catalogue for personal-bingo CA tiles.
//
// WikiSync (rankData.fetchWikiSyncCA) reports a player's COMPLETED CA task ids in the OSRS
// Wiki's own 0-based id space, and rankScoring/combatAchievements.json already tiers those
// ids. This module supplies the NAMES for that same id space.
//
// MAINTENANCE-FREE BY DESIGN: a committed snapshot (data/caTasks.json) seeds the catalogue so
// the feature works offline / in CI, and a lazy refresh pulls the *current* full list from the
// OSRS Wiki "bucket" API (the same source the wiki's own rank tools use), cached in memory.
// New CAs are appended at the end of the id space and never renumber existing ones, so the
// live fetch simply extends the snapshot — the JSON never needs hand-editing. Any fetch
// failure silently keeps whatever we already have (seed or a prior successful fetch).

import caSeed from './data/caTasks.json';

export interface CaTask {
	id: number;
	name: string;
	tier: string; // 'easy' | 'medium' | 'hard' | 'elite' | 'master' | 'grandmaster'
}

const SEED = caSeed as CaTask[];

// Wiki "bucket" query: every combat achievement's id, name and tier in one page (limit 5000
// comfortably covers the ~640 tasks). Mirrors what public WikiSync rank calculators query.
const WIKI_BUCKET_URL =
	'https://oldschool.runescape.wiki/api.php?action=bucket&format=json&query=' +
	encodeURIComponent(
		'bucket("combat_achievement").select("id","name","tier").limit(5000).run()'
	);
const USER_AGENT = 'Volition-Site personal-bingo (github.com/ehubbartt/volition-site)';
const REFRESH_TTL_MS = 24 * 60 * 60 * 1000; // re-fetch from the wiki at most once a day on success
const RETRY_COOLDOWN_MS = 5 * 60 * 1000; // ...but back off only this long after a failure
const FETCH_TIMEOUT_MS = 8000; // never let a slow wiki hang board generation

let cache = new Map<number, CaTask>(SEED.map((t) => [t.id, t]));
let nextFetchAllowed = 0; // epoch ms before which ensureFresh() is a no-op
let inflight: Promise<void> | null = null;

async function refreshFromWiki(): Promise<void> {
	try {
		const res = await fetch(WIKI_BUCKET_URL, {
			headers: { 'User-Agent': USER_AGENT },
			signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
		});
		if (!res.ok) throw new Error(`wiki bucket ${res.status}`);
		const json = (await res.json()) as {
			bucket?: { id?: number; name?: string; tier?: string }[];
		};
		if (!json?.bucket?.length) throw new Error('wiki bucket empty');
		// Seed first so any id the wiki omits still resolves; live rows then supersede + extend.
		const merged = new Map<number, CaTask>(SEED.map((t) => [t.id, t]));
		for (const row of json.bucket) {
			if (typeof row.id !== 'number' || !row.name || !row.tier) continue;
			merged.set(row.id, { id: row.id, name: row.name, tier: String(row.tier).toLowerCase() });
		}
		cache = merged;
		nextFetchAllowed = Date.now() + REFRESH_TTL_MS;
	} catch {
		// network/parse failure — keep the existing catalogue (seed or last good fetch) and retry
		// after a short cooldown rather than on every board generation.
		nextFetchAllowed = Date.now() + RETRY_COOLDOWN_MS;
	}
}

// Refresh from the wiki when due, coalescing concurrent callers onto one fetch. Always resolves
// (never throws); the seed guarantees a usable catalogue even if the wiki is unreachable.
async function ensureFresh(): Promise<void> {
	if (Date.now() < nextFetchAllowed) return;
	if (!inflight) inflight = refreshFromWiki().finally(() => (inflight = null));
	await inflight;
}

// The full id→name→tier catalogue (seed, extended/overridden by the latest wiki fetch).
export async function getCATasks(): Promise<CaTask[]> {
	await ensureFresh();
	return [...cache.values()];
}
