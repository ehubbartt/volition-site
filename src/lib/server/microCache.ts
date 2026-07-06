// Tiny in-memory TTL cache for SHARED, identity-independent data (event lists,
// headline stats, the clan roster, the calendar) — the same trick as the
// adminRoles/bans caches. Endpoints that every member hits on navigation can
// serve repeat requests without touching the database for a few seconds.
//
// RULES: never cache anything derived from a specific user (that would leak
// between users — module state is shared across requests), and give mutating
// actions a bust() call when members would notice the staleness (e.g. an admin
// adds a calendar entry and expects to see it immediately).

type Entry = { value: unknown; expiresAt: number };

const store = new Map<string, Entry>();
const inflight = new Map<string, Promise<unknown>>();

export async function microCached<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
	const hit = store.get(key);
	if (hit && hit.expiresAt > Date.now()) return hit.value as T;

	// Concurrent callers share one in-flight fetch instead of stampeding the DB.
	const running = inflight.get(key);
	if (running) return running as Promise<T>;

	const p = fn()
		.then((value) => {
			store.set(key, { value, expiresAt: Date.now() + ttlMs });
			return value;
		})
		.finally(() => {
			inflight.delete(key);
		});
	inflight.set(key, p);
	return p;
}

// Drop every entry whose key starts with `prefix` — call from mutating actions
// so the acting user sees their change immediately.
export function bustMicroCache(prefix: string): void {
	for (const key of store.keys()) {
		if (key.startsWith(prefix)) store.delete(key);
	}
}
