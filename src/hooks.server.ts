import type { Handle } from '@sveltejs/kit';
import { env } from '$env/dynamic/public';
import { env as serverEnv } from '$env/dynamic/private';
import { readSession } from '$lib/server/auth';
import { getBan } from '$lib/server/bans';
import { shouldAudit, capturePayload, captureBeforeState, logAudit } from '$lib/server/audit';

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
	// Health probe — answer BEFORE the canonical-host redirect below. Fly's internal
	// check hits the machine on its *.internal/.fly.dev host (Host !== CANONICAL_HOST),
	// so otherwise it would get a 308 and read as unhealthy. Also skips the session read,
	// ban check, and audit work — a health probe needs none of it. Used by the Fly
	// http_service check (fly.toml) + any external uptime monitor.
	if (event.url.pathname === '/health') {
		return new Response(JSON.stringify({ ok: true, region: serverEnv.FLY_REGION ?? 'local' }), {
			status: 200,
			headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }
		});
	}

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

	// Banned users (the bot's `bans` table, keyed by Discord id) can't use the site.
	// Send every authenticated request to /banned — except the /banned page itself,
	// logout (so they can leave), and static assets (so /banned can render). Only
	// queried when a session resolved, so logged-out browsing is unaffected.
	event.locals.ban = session?.user ? await getBan(session.user.discord_id) : null;
	if (event.locals.ban) {
		const path = event.url.pathname;
		const allowed =
			path === '/banned' ||
			path.startsWith('/auth/logout') ||
			path.startsWith('/_app/') ||
			path.includes('.'); // fonts, images, favicon, etc.
		if (!allowed) {
			return new Response(null, { status: 303, headers: { location: '/banned' } });
		}
	}

	// Automatic admin audit log. Capture the form payload BEFORE resolve() consumes the
	// request body (clone so the action still reads it), then record the row after we
	// know the response status. Best-effort + fire-and-forget — never blocks/breaks the
	// request. See src/lib/server/audit.ts.
	const audit = shouldAudit(event);
	const payload = audit ? await capturePayload(event.request.clone()) : null;
	// For DB-row edits, snapshot the OLD row now (before resolve mutates it) so the audit
	// viewer can show a before→after diff. Best-effort; only fires for the table editor.
	if (audit && payload) {
		const before = await captureBeforeState(event, payload);
		if (before) payload._before = before;
	}

	const response = await resolve(event);

	if (audit && payload) void logAudit(event, response.status, payload);

	return response;
};
