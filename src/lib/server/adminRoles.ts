import { db } from './db';

// In-memory cache of DB-granted roles from vs_admin_roles.
//
// Why a cache: isAdmin()/isCardTester() are SYNCHRONOUS and called from ~50 load
// functions and form actions. Rather than make every call site async, we refresh
// this cache once per request in hooks.server.ts (TTL-guarded, so it's usually a
// no-op) and read it synchronously from auth.ts. This mirrors the bot's 60s
// bot_config polling model. Fly runs a long-lived Node server (adapter-node), so
// module state persists across requests; each machine keeps its own cache and
// converges within the TTL. A grant/revoke forces an immediate local refresh.

const TTL_MS = 30_000;

type Cache = {
	admins: Set<string>;
	cardTesters: Set<string>;
	fetchedAt: number;
	loaded: boolean;
};

const cache: Cache = {
	admins: new Set(),
	cardTesters: new Set(),
	fetchedAt: 0,
	loaded: false
};

let inflight: Promise<void> | null = null;

async function doRefresh(): Promise<void> {
	const { data, error } = await db()
		.from('vs_admin_roles')
		.select('discord_id, role');

	if (error) {
		// Keep the previous cache on failure. On first-ever load this leaves the sets
		// empty, so only env-listed admins/owners work — fail-CLOSED for DB grants,
		// fail-OPEN for env (owners are never locked out by a DB outage).
		cache.fetchedAt = Date.now();
		return;
	}

	const admins = new Set<string>();
	const cardTesters = new Set<string>();
	for (const row of data ?? []) {
		if (row.role === 'admin') admins.add(row.discord_id);
		else if (row.role === 'card_tester') cardTesters.add(row.discord_id);
	}
	cache.admins = admins;
	cache.cardTesters = cardTesters;
	cache.fetchedAt = Date.now();
	cache.loaded = true;
}

// Refresh the cache if it's stale (or never loaded). Call once per request from
// hooks.server.ts before any permission check. Concurrent callers share one query.
export async function ensureFreshAdminRoles(force = false): Promise<void> {
	const stale = force || !cache.loaded || Date.now() - cache.fetchedAt > TTL_MS;
	if (!stale) return;
	if (!inflight) {
		inflight = doRefresh().finally(() => {
			inflight = null;
		});
	}
	await inflight;
}

// Synchronous getters for auth.ts. Reflect the last successful refresh.
export function dbAdminIds(): ReadonlySet<string> {
	return cache.admins;
}

export function dbCardTesterIds(): ReadonlySet<string> {
	return cache.cardTesters;
}
