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
// Monotonic generation per key, bumped by bustMicroCache. An in-flight fetch
// captures the generation it started under and only writes to `store` if that
// generation is still current — so a query that began BEFORE a mutation
// committed can't repopulate the cache with pre-mutation data after the bust.
const generation = new Map<string, number>();

export async function microCached<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
	const hit = store.get(key);
	if (hit && hit.expiresAt > Date.now()) return hit.value as T;

	// Concurrent callers share one in-flight fetch instead of stampeding the DB.
	const running = inflight.get(key);
	if (running) return running as Promise<T>;

	const startGen = generation.get(key) ?? 0;
	const p = fn()
		.then((value) => {
			// Skip the write if a bust happened while this fetch was in flight.
			if ((generation.get(key) ?? 0) === startGen) {
				store.set(key, { value, expiresAt: Date.now() + ttlMs });
			}
			return value;
		})
		.finally(() => {
			if (inflight.get(key) === p) inflight.delete(key);
		});
	inflight.set(key, p);
	return p;
}
// NOTE: a rejected fn() is never cached (the .then above only runs on success),
// so callers wrapping a Supabase query MUST throw on `error` INSIDE fn — returning
// an { error } response would cache the failure for the whole TTL.

// Drop every entry whose key starts with `prefix` — call from mutating actions
// so the acting user sees their change immediately. Bumps the generation of every
// matching in-flight fetch so a pre-mutation query in progress can't write back.
export function bustMicroCache(prefix: string): void {
	for (const key of store.keys()) {
		if (key.startsWith(prefix)) store.delete(key);
	}
	for (const key of inflight.keys()) {
		if (key.startsWith(prefix)) generation.set(key, (generation.get(key) ?? 0) + 1);
	}
}

// Bust every cache derived from vs_events: the events list (per admin-visibility)
// plus the homepage calendar milestones and headline stats. Any admin action that
// creates, edits, deletes, or changes the status of an event calls this so all
// three surfaces reflect the change immediately instead of within the TTL.
export function bustEventCaches(): void {
	bustMicroCache('events:list');
	bustMicroCache('home:calendar');
	bustMicroCache('home:stats');
}
