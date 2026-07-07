import { redirect, error } from '@sveltejs/kit';
// Type-only import — erased at build time, so this stays a universal module.
import type { SessionUser } from '$lib/server/auth';
import { swr, type Swr } from '$lib/swr';

// The standard access gates for instant-navigation pages (see docs/ARCHITECTURE.md).
// Universal loads run these against the layout's already-loaded data — `await
// parent()` costs no network — so redirects/403s still happen before the page
// renders. The admin gates here are UX ONLY: the real enforcement is the role
// re-check inside every admin API endpoint (see lib/server/apiEndpoint.ts).
// - 'public':     logged-out OK; logged-in-but-not-onboarded → /onboarding  (home)
// - 'member':     signed in required, onboarding not          (/me, personal bingo)
// - 'onboarded':  signed in + rsn/allegiance/account type set (most member pages)
// - 'admin' / 'superAdmin' / 'cardAdmin': signed in + the layout role flag, else 403
export type InstantGuard = 'public' | 'member' | 'onboarded' | 'admin' | 'superAdmin' | 'cardAdmin';

export type GuardData = {
	user: SessionUser | null;
	isAdmin?: boolean;
	isSuperAdmin?: boolean;
	isCardTester?: boolean;
};

export function instantGuard(data: GuardData, guard: InstantGuard): void {
	const { user } = data;
	if (guard !== 'public' && !user) redirect(303, '/');
	if (guard === 'admin' && !data.isAdmin) error(403, 'Not allowed');
	if (guard === 'superAdmin' && !data.isSuperAdmin) error(403, 'Not allowed');
	if (guard === 'cardAdmin' && !(data.isAdmin || data.isCardTester)) error(403, 'Not allowed');
	if (
		(guard === 'onboarded' || guard === 'public') &&
		user &&
		(!user.rsn || !user.clan_allegiance || !user.account_type)
	) {
		redirect(303, '/onboarding');
	}
}

// Minimal structural view of a page-load event: every route's generated event is
// assignable to it, so `export const load: PageLoad = instantLoad(...)` typechecks
// per-route without this module depending on any one route's $types.
type LoadCtx = {
	parent: () => Promise<GuardData>;
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
		const data = await parent();
		instantGuard(data, opts.guard);
		const target =
			typeof opts.url === 'function' ? opts.url({ params, url, user: data.user }) : opts.url;
		return { [opts.key]: swr<T>(fetch, target) } as Record<K, Swr<T>>;
	};
}
