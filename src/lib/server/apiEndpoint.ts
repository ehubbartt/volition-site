import { json, error, type RequestEvent } from '@sveltejs/kit';
import type { SessionUser } from '$lib/server/auth';

// Factories for the instant-navigation data endpoints (see docs/ARCHITECTURE.md).
// Each endpoint re-checks the session itself — the client-side gates in the
// universal loads are UX, not security — and sends no-store so the browser never
// caches a personalized payload (the client-side swr cache handles reuse).

const NO_STORE = { 'cache-control': 'no-store' } as const;

export function memberEndpoint<T>(
	build: (user: SessionUser, event: RequestEvent) => Promise<T>
): (event: RequestEvent) => Promise<Response> {
	return async (event) => {
		const user = event.locals.user;
		if (!user) throw error(401, 'Not signed in');
		return json(await build(user, event), { headers: NO_STORE });
	};
}

// Same shape, logged-out allowed (endpoints that serve public variants).
export function publicEndpoint<T>(
	build: (user: SessionUser | null, event: RequestEvent) => Promise<T>
): (event: RequestEvent) => Promise<Response> {
	return async (event) => json(await build(event.locals.user, event), { headers: NO_STORE });
}
