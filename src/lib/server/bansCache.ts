import { db, fetchAllFiltered } from './db';
import type { Ban } from './bans';

// In-memory cache of the bot-owned `bans` table, mirroring adminRoles.ts.
//
// Why a cache: the ban gate runs in hooks.server.ts on EVERY authenticated page
// request, and it used to be its own blocking Supabase round-trip sequenced after
// the session read. The table is tiny and changes rarely, so we refresh the whole
// thing on a TTL (usually a no-op) and read it synchronously. Fly runs a long-lived
// Node server (adapter-node), so module state persists; each machine converges
// within the TTL, and ban/unban actions force an immediate local refresh.

const TTL_MS = 30_000;

type Cache = {
	byDiscordId: Map<string, Ban>;
	fetchedAt: number;
	loaded: boolean;
};

const cache: Cache = {
	byDiscordId: new Map(),
	fetchedAt: 0,
	loaded: false
};

let inflight: Promise<void> | null = null;

async function doRefresh(): Promise<void> {
	// Page past PostgREST's 1000-row cap — a bare select() would silently keep only
	// the first 1000 bans, letting anyone beyond that arbitrary cutoff through.
	const { data, error } = await fetchAllFiltered<Ban>((from, to) =>
		db().from('bans').select('discord_id, reason, created_at').range(from, to)
	);

	if (error) {
		// Keep the previous cache on failure — same fail-open posture as the old
		// per-request getBan (a DB outage never locks everyone out).
		cache.fetchedAt = Date.now();
		return;
	}

	const map = new Map<string, Ban>();
	for (const row of (data ?? []) as Ban[]) {
		map.set(row.discord_id, row);
	}
	cache.byDiscordId = map;
	cache.fetchedAt = Date.now();
	cache.loaded = true;
}

// Refresh if stale (or never loaded). Called once per request from hooks.server.ts;
// concurrent callers share one query. Ban/unban actions call with force=true so the
// acting machine enforces immediately.
export async function ensureFreshBans(force = false): Promise<void> {
	if (force) {
		// A ban/unban just wrote a row. Don't JOIN an in-flight refresh — its SELECT
		// may have snapshotted before the write. Wait for any in-flight read to
		// finish, then run a fresh one whose read starts after this call, so its
		// write lands last and reflects the change.
		const prev = inflight;
		const p = (async () => {
			if (prev) await prev.catch(() => {});
			await doRefresh();
		})();
		inflight = p.finally(() => {
			if (inflight === p) inflight = null;
		});
		return p;
	}
	const stale = !cache.loaded || Date.now() - cache.fetchedAt > TTL_MS;
	if (!stale) return;
	if (!inflight) {
		inflight = doRefresh().finally(() => {
			inflight = null;
		});
	}
	await inflight;
}

// Synchronous read reflecting the last successful refresh.
export function getBanCached(discordId: string | null): Ban | null {
	if (!discordId) return null;
	return cache.byDiscordId.get(discordId) ?? null;
}
