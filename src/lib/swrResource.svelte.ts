import { goto } from '$app/navigation';
import type { Swr } from '$lib/swr';

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
// - Null fresh results (fetch error) never overwrite data — the cached/loaded
//   content stays on screen.
export function swrResource<T>(
	source: () => Swr<T>,
	empty: T,
	opts?: { onFresh?: (data: NonNullable<T>) => void }
): { readonly value: T; readonly ready: boolean; readonly loaded: T | null } {
	let loaded = $state<T | null>(null);
	$effect(() => {
		const src = source(); // tracked: re-runs when the load result is replaced
		loaded = null;
		let current = true;
		src.fresh.then((d) => {
			if (!current || d == null) return;
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
		}
	};
}

// Variant for discriminated payloads where the endpoint decides the outcome
// (`kind: 'not_found' | 'redirect' | <renderable kinds>`). Only FRESH responses may
// steer: a cached redirect/not_found is never rendered and never acted on, so a
// stale outcome can't bounce the user around — the page shows its skeleton until
// the fresh verdict lands. Renderable cached payloads still first-paint instantly.
type Steering = { kind: 'not_found' } | { kind: 'redirect'; to: string };
type Renderable<P> = Exclude<P, Steering>;

export function swrRouted<P extends { kind: string }>(
	source: () => Swr<P>,
	opts?: { onFresh?: (payload: Renderable<P>) => void }
): { readonly payload: Renderable<P> | null; readonly ready: boolean; readonly notFound: boolean } {
	let loaded = $state<Renderable<P> | null>(null);
	let notFound = $state(false);
	$effect(() => {
		const src = source();
		loaded = null;
		notFound = false;
		let current = true;
		src.fresh.then((d) => {
			if (!current) return;
			// null = fetch error; treated as not found, same as the hand-written pages.
			if (!d || d.kind === 'not_found') {
				notFound = true;
				return;
			}
			if (d.kind === 'redirect') {
				goto((d as unknown as { to: string }).to, { replaceState: true });
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
		}
	};
}
