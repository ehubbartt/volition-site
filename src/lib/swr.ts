import { browser } from '$app/environment';

// Stale-while-revalidate for the streamed page payloads (see the instant-navigation
// section in docs/ARCHITECTURE.md). Universal loads call swr() instead of a bare
// fetch: the page seeds its state from `cached` — the last payload this browser saw
// for that URL — so revisited pages render REAL content in the same frame as the
// click, while `fresh` refetches in the background and swaps in silently.
//
// The cache is CLIENT-ONLY (module state in the browser bundle, keyed by URL, lives
// until a full page reload). On the server `cached` is always null — a server-side
// cache here would leak one user's payload to another, since module state is shared
// across requests.
const cache = new Map<string, unknown>();

export type Swr<T> = { cached: T | null; fresh: Promise<T | null> };

export function swr<T>(fetchFn: typeof fetch, url: string): Swr<T> {
	const fresh = fetchFn(url)
		.then((r) => {
			if (!r.ok) throw new Error(`${url} ${r.status}`);
			return r.json() as Promise<T>;
		})
		.then((data) => {
			// Never cache null/undefined — `cached: null` must always mean "no data yet".
			if (browser && data != null) cache.set(url, data);
			return data;
		})
		.catch(() => null);
	return {
		// LIVE getter, not a snapshot: on back/forward navigation SvelteKit reuses
		// the previous load result without re-running the load, so a snapshot taken
		// before the first fetch finished would stay null forever. Reading the map
		// at access time means a revisited page sees whatever its last fetch stored.
		get cached() {
			return browser ? ((cache.get(url) as T | undefined) ?? null) : null;
		},
		fresh
	};
}

export const emptySwr = <T>(value: T | null = null): Swr<T> => ({
	cached: value,
	fresh: Promise.resolve(value)
});
