import { goto, invalidateAll } from '$app/navigation';
import type { Swr, SwrError } from '$lib/swr';

// Component-side resolver for the streamed payloads produced by instantLoad/swr
// (see docs/ARCHITECTURE.md, instant navigation). Call during component init:
//
//   const tasks = swrResource(() => pageData.tasks, [] as PlayerTask[]);
//   ...
//   {#if tasks.ready} {tasks.value} {:else} <Skeleton /> {/if}
//
// What it owns, so pages don't re-implement it:
// - `value` falls back to the LIVE client cache (`source().cached`, read at access
//   time — never snapshotted), so revisits and back/forward first-paint real content
//   in the same frame as the navigation instead of flashing a skeleton.
// - The $effect resolves `fresh` with a staleness flag so a superseded fetch can
//   never clobber a newer navigation's data.
// - The source is a GETTER so the effect re-runs when SvelteKit replaces the load
//   result (param navigation, post-action invalidation). On re-run `loaded` resets:
//   a slug→slug navigation shows the NEW url's cached payload or skeleton rather
//   than the previous slug's data. Same-URL revalidation is unaffected — `value`
//   falls back to `cached`, which the previous fetch populated, so the page keeps
//   its content with no skeleton flash.
// - Failed fetches never overwrite data: the cached/loaded content stays on screen
//   and `error` reports why the refresh failed (pages MAY surface it; none must).
// - A 401/403 means our session or role went stale mid-browse (the layout load
//   doesn't re-run on client navigation by itself). One throttled invalidateAll()
//   re-runs every load: the layout refreshes `user`/role flags and the existing
//   guards redirect — instead of the page silently turning into skeletons forever.

let lastAuthResync = 0;
function maybeResyncAuth(err: SwrError | null): void {
	if (err?.status !== 401 && err?.status !== 403) return;
	const now = Date.now();
	if (now - lastAuthResync < 5_000) return; // throttle: never loop invalidations
	lastAuthResync = now;
	void invalidateAll();
}

export function swrResource<T>(
	source: () => Swr<T>,
	empty: T,
	opts?: { onFresh?: (data: NonNullable<T>) => void }
): {
	readonly value: T;
	readonly ready: boolean;
	readonly loaded: T | null;
	readonly error: SwrError | null;
} {
	let loaded = $state<T | null>(null);
	$effect(() => {
		const src = source(); // tracked: re-runs when the load result is replaced
		loaded = null;
		let current = true;
		src.fresh.then((d) => {
			if (!current) return;
			if (d == null) {
				maybeResyncAuth(src.error);
				return;
			}
			loaded = d;
			opts?.onFresh?.(d);
		});
		return () => {
			current = false;
		};
	});
	return {
		get loaded() {
			return loaded;
		},
		get value() {
			return loaded ?? source().cached ?? empty;
		},
		get ready() {
			return loaded !== null || source().cached !== null;
		},
		get error() {
			return source().error;
		}
	};
}

// Variant for discriminated payloads where the endpoint decides the outcome.
// Builders compose this Steering contract (type-only import, erased at build) so
// the kind strings can't drift between server and client:
export type Steering = { kind: 'not_found' } | { kind: 'redirect'; to: string };
type Renderable<P> = Exclude<P, Steering>;

// Only FRESH responses may steer: a cached redirect/not_found is never rendered
// and never acted on, so a stale outcome can't bounce the user around. And only a
// REAL `kind: 'not_found'` payload sets notFound — a failed fetch (network blip,
// expired session) keeps the cached payload on screen, or stays on the skeleton
// with `error` set; it must never repaint working content as "not found".
export function swrRouted<P extends { kind: string }>(
	source: () => Swr<P>,
	opts?: { onFresh?: (payload: Renderable<P>) => void }
): {
	readonly payload: Renderable<P> | null;
	readonly ready: boolean;
	readonly notFound: boolean;
	readonly error: SwrError | null;
} {
	let loaded = $state<Renderable<P> | null>(null);
	let notFound = $state(false);
	$effect(() => {
		const src = source();
		loaded = null;
		notFound = false;
		let current = true;
		src.fresh.then((d) => {
			if (!current) return;
			if (d == null) {
				maybeResyncAuth(src.error);
				return;
			}
			if (d.kind === 'not_found') {
				notFound = true;
				return;
			}
			if (d.kind === 'redirect') {
				// Structural narrowing (P only guarantees `kind`); builders compose
				// Steering, so `to` is always present on redirect payloads.
				if ('to' in d && typeof (d as { to?: unknown }).to === 'string') {
					goto((d as { to: string }).to, { replaceState: true });
				}
				return;
			}
			notFound = false;
			loaded = d as Renderable<P>;
			opts?.onFresh?.(d as Renderable<P>);
		});
		return () => {
			current = false;
		};
	});
	const payload = (): Renderable<P> | null => {
		if (loaded) return loaded;
		const c = source().cached;
		return c && c.kind !== 'not_found' && c.kind !== 'redirect' ? (c as Renderable<P>) : null;
	};
	return {
		get payload() {
			return payload();
		},
		get ready() {
			return payload() !== null;
		},
		get notFound() {
			return notFound;
		},
		get error() {
			return source().error;
		}
	};
}
