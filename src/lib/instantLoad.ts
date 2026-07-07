import { redirect } from '@sveltejs/kit';
// Type-only import — erased at build time, so this stays a universal module.
import type { SessionUser } from '$lib/server/auth';
import { swr, type Swr } from '$lib/swr';

// The standard access gates for instant-navigation pages (see docs/ARCHITECTURE.md).
// Universal loads run these against the layout's session — `await parent()` costs no
// network — so redirects still happen before the page renders:
// - 'public':    logged-out OK; logged-in-but-not-onboarded → /onboarding   (home)
// - 'member':    signed in required, onboarding not          (/me, personal bingo)
// - 'onboarded': signed in + rsn/allegiance/account type set (most member pages)
export type InstantGuard = 'public' | 'member' | 'onboarded';

export function instantGuard(user: SessionUser | null, guard: InstantGuard): void {
	if (guard !== 'public' && !user) redirect(303, '/');
	if (guard !== 'member' && user && (!user.rsn || !user.clan_allegiance || !user.account_type)) {
		redirect(303, '/onboarding');
	}
}

// Minimal structural view of a page-load event: every route's generated event is
// assignable to it, so `export const load: PageLoad = instantLoad(...)` typechecks
// per-route without this module depending on any one route's $types.
type LoadCtx = {
	parent: () => Promise<{ user: SessionUser | null }>;
	fetch: typeof globalThis.fetch;
	params: Partial<Record<string, string>>;
	url: URL;
};

type UrlSpec =
	| string
	| ((ctx: { params: Partial<Record<string, string>>; url: URL; user: SessionUser | null }) => string);

// The whole standard instant-nav load in one call: gate the visitor, then kick off
// the API fetch WITHOUT awaiting it — navigation completes immediately and the page
// resolves the payload behind skeletons (see swrResource.svelte.ts). Pages that need
// multiple keys or a mapped payload compose instantGuard + swr + mapSwr by hand.
export function instantLoad<T, K extends string>(opts: {
	key: K;
	guard: InstantGuard;
	url: UrlSpec;
}): (event: LoadCtx) => Promise<Record<K, Swr<T>>> {
	return async ({ parent, fetch, params, url }) => {
		const { user } = await parent();
		instantGuard(user, opts.guard);
		const target = typeof opts.url === 'function' ? opts.url({ params, url, user }) : opts.url;
		return { [opts.key]: swr<T>(fetch, target) } as Record<K, Swr<T>>;
	};
}
