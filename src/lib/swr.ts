import { browser } from '$app/environment';

// Stale-while-revalidate for the streamed page payloads (see the instant-navigation
// section in docs/ARCHITECTURE.md). Universal loads call swr() instead of a bare
// fetch: the page seeds its state from `cached` — the last payload this browser saw
// for that URL — so revisited pages render REAL content in the same frame as the
// click, while `fresh` refetches in the background and swaps in silently.
//
// The cache is CLIENT-ONLY (module state in the browser bundle, keyed by URL, lives
// until a full document load). On the server `swr()` doesn't fetch at all: the SSR
// pass paints skeletons regardless (effects don't run server-side and the result
// can't be serialized from an unawaited promise), so a server-side fetch would just
// run the data builder a second time and throw the result away. A server-side cache
// would also leak one user's payload to another, since module state is shared
// across requests.
const cache = new Map<string, unknown>();
// Per-URL write counter: a slow, superseded fetch must not overwrite the cache
// entry a newer fetch already wrote (the on-screen state is separately protected
// by the staleness flag in swrResource, but the NEXT visit reads this map).
const writes = new Map<string, number>();

// Why the fetch failed: HTTP status, or null for a network-level error. Consumed
// by swrResource/swrRouted — a 401/403 triggers an auth resync, anything else just
// means "keep showing what we have".
export type SwrError = { status: number | null };

export type Swr<T> = {
	cached: T | null;
	fresh: Promise<T | null>;
	readonly error: SwrError | null;
};

export function swr<T>(fetchFn: typeof fetch, url: string): Swr<T> {
	if (!browser) {
		return { cached: null, fresh: Promise.resolve(null), error: null };
	}
	const ticket = (writes.get(url) ?? 0) + 1;
	writes.set(url, ticket);
	let error: SwrError | null = null;
	const fresh = fetchFn(url)
		.then((r) => {
			if (!r.ok) {
				error = { status: r.status };
				return null;
			}
			return r.json() as Promise<T>;
		})
		.then((data) => {
			// Never cache null/undefined — `cached: null` must always mean "no data yet".
			// The ticket check keeps an out-of-order (older) response from regressing
			// the cache after a newer fetch already stored its payload.
			if (data != null && writes.get(url) === ticket) cache.set(url, data);
			return data;
		})
		.catch(() => {
			error ??= { status: null };
			return null;
		});
	return {
		// LIVE getter, not a snapshot, so every consumer of this object — including
		// ones created by hover-preload or reused by the router — always sees the
		// newest payload the cache holds for this URL at the moment of access.
		get cached() {
			return (cache.get(url) as T | undefined) ?? null;
		},
		fresh,
		get error() {
			return error;
		}
	};
}

export const emptySwr = <T>(value: T | null = null): Swr<T> => ({
	cached: value,
	fresh: Promise.resolve(value),
	error: null
});

// Live-getter view over another Swr, for loads that expose a slice of a shared
// fetch (e.g. one /api/home response feeding several panels). NEVER snapshots
// `cached` — reading the source getter at access time is what keeps revisits
// current (see the `cached` comment above).
export function mapSwr<T, U>(src: Swr<T>, fn: (t: T) => U | null): Swr<U> {
	return {
		get cached() {
			const c = src.cached;
			return c == null ? null : fn(c);
		},
		fresh: src.fresh.then((t) => (t == null ? null : fn(t))),
		get error() {
			return src.error;
		}
	};
}

// Drop everything (e.g. on a client-side auth transition, so the next viewer on a
// shared machine can't first-paint the previous member's payloads). Today logout is
// a NATIVE form post — a full document load that wipes module state — so nothing
// calls this yet; it exists so any future client-side logout has a correct tool.
export function clearSwrCache(): void {
	cache.clear();
	writes.clear();
}
