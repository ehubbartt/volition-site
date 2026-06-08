import type { Handle } from '@sveltejs/kit';
import { env } from '$env/dynamic/public';
import { readSession } from '$lib/server/auth';

// Force a single canonical origin. Discord OAuth stores its state in a
// per-domain cookie, so starting login on ANY non-canonical host (the old Fly
// domain, a www subdomain, etc.) but having the callback fire on the custom
// domain strands the cookie → "Invalid OAuth state" (400). Redirecting every
// off-canonical host up front keeps login, cookies, and the callback on one
// origin. Only active in prod (PUBLIC_SITE_URL is https); dev/localhost matches
// the canonical host so it's untouched, and there are no HTTP health checks to
// break (see fly.toml).
const CANONICAL = (env.PUBLIC_SITE_URL ?? '').replace(/\/+$/, '');
let CANONICAL_HOST = '';
try {
	CANONICAL_HOST = CANONICAL ? new URL(CANONICAL).host : '';
} catch {
	CANONICAL_HOST = '';
}

export const handle: Handle = async ({ event, resolve }) => {
	if (
		CANONICAL_HOST &&
		CANONICAL.startsWith('https://') &&
		event.url.host !== CANONICAL_HOST
	) {
		return new Response(null, {
			status: 308,
			headers: { location: `${CANONICAL}${event.url.pathname}${event.url.search}` }
		});
	}

	const session = await readSession(event.cookies);
	event.locals.user = session?.user ?? null;
	event.locals.sessionId = session?.sessionId ?? null;
	return resolve(event);
};
