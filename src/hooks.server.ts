import type { Handle, HandleServerError } from '@sveltejs/kit';
import { env } from '$env/dynamic/public';
import { env as serverEnv } from '$env/dynamic/private';
import { readSession, isAdmin, isSuperAdmin, invalidateSessionCache } from '$lib/server/auth';
import { ensureFreshAdminRoles } from '$lib/server/adminRoles';
import { ensureFreshBans, getBanCached } from '$lib/server/bansCache';
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

// STAGING LOCK: when STAGING_ADMIN_ONLY is truthy (set only on the staging Fly app), the
// whole site is restricted to admins so in-progress features aren't exposed to members. Unset
// in prod, so prod is unaffected. Read once at startup.
const STAGING_ADMIN_ONLY = /^(1|true|on|yes)$/i.test((serverEnv.STAGING_ADMIN_ONLY ?? '').trim());

// A request is for a static asset (and so skips the staging + ban gates) if it's a
// build artifact under /_app/ or ends in a known static-file extension. This is a
// real extension list rather than "the path contains a dot" ON PURPOSE: route
// params can contain dots (e.g. /api/events/<slug>), and a bare dot check would let
// a banned user — or an anonymous visitor on the staging lock — reach those routes.
const STATIC_EXT =
	/\.(?:js|mjs|css|map|ico|png|jpe?g|gif|svg|webp|avif|woff2?|ttf|otf|eot|txt|xml|json|webmanifest|mp4|webm|ogg|mp3|wav|pdf)$/i;
function isStaticAsset(path: string): boolean {
	return path.startsWith('/_app/') || STATIC_EXT.test(path);
}

// Minimal admin-only notice for the staging lock (no app assets needed — inline styles). Shows
// a Discord sign-in link when signed out, or a "not an admin" note (+ logout) when signed in.
function stagingLockResponse(signedIn: boolean): Response {
	const body = signedIn
		? `<p>This is the <strong>staging</strong> site and it's restricted to admins.</p>
		   <p class="muted">Your account isn't an admin here.</p>
		   <form method="POST" action="/auth/logout" style="margin:0">
		     <button class="btn" type="submit" style="border:none;cursor:pointer;font:inherit">Log out</button>
		   </form>`
		: `<p>This is the <strong>staging</strong> site and it's restricted to admins.</p>
		   <a class="btn" href="/auth/discord/login">Sign in with Discord</a>`;
	const html = `<!doctype html><html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex" /><title>Volition — staging</title>
<style>
  html,body{height:100%;margin:0}
  body{display:flex;align-items:center;justify-content:center;background:#1b1b1b;color:#e8e0d0;
       font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;text-align:center;padding:1.5rem}
  .card{max-width:26rem}
  h1{color:#ff981f;font-size:1.3rem;margin:0 0 .75rem}
  p{line-height:1.5;margin:.4rem 0}
  .muted{color:#a99}
  .btn{display:inline-block;margin-top:1rem;padding:.6rem 1.1rem;background:#4d4336;color:#ff981f;
       text-decoration:none;border-radius:6px;border:1px solid #6a5a3f}
</style></head>
<body><div class="card"><h1>Volition — staging</h1>${body}</div></body></html>`;
	return new Response(html, {
		status: signedIn ? 403 : 401,
		headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }
	});
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

	// One parallel round: the session read plus the two TTL-guarded cache refreshes
	// (vs_admin_roles, bans). The caches are no-ops on most requests, and none of the
	// three depends on another — sequencing them (as before) stacked 2-3 blocking
	// Supabase round-trips onto every navigation. Cache failures keep the last good
	// state (env admins/owners still work; a bans outage fails open, as before).
	const [session] = await Promise.all([
		readSession(event.cookies),
		ensureFreshAdminRoles().catch(() => {}),
		ensureFreshBans().catch(() => {})
	]);
	event.locals.user = session?.user ?? null;
	event.locals.sessionId = session?.sessionId ?? null;

	// Staging lock: gate the whole site behind admin. The auth flow (so an admin can sign in)
	// and static assets stay open; /health already returned above. Runs after the admin-role
	// cache refresh so DB-granted admins are recognised. Checked against the RAW user —
	// BEFORE the view-as override below — so a super admin previewing as "member" isn't
	// locked out of staging by their own preview.
	if (STAGING_ADMIN_ONLY) {
		const gatePath = event.url.pathname;
		const openForLogin = gatePath.startsWith('/auth/') || isStaticAsset(gatePath);
		if (!openForLogin && !isAdmin(event.locals.user)) {
			return stagingLockResponse(!!event.locals.user);
		}
	}

	// VIEW-AS (super admins only): preview the site as a lower role. The override is
	// applied ONLY when the real session user is a super admin, and every preview role
	// is below super admin — so it can strictly REDUCE privileges, never escalate.
	// From here on, every role check (layout flags, page guards, endpoint factories,
	// form-action gates, isClanMember) answers as the previewed role; the real
	// identity stays in locals.realSuperAdmin so the switcher itself keeps working.
	event.locals.realSuperAdmin = isSuperAdmin(event.locals.user);
	if (event.locals.realSuperAdmin && event.locals.user) {
		const viewAs = event.cookies.get('vs_view_as');
		if (viewAs === 'admin' || viewAs === 'member' || viewAs === 'guest') {
			event.locals.user = { ...event.locals.user, view_as: viewAs };
		}
	}

	// Banned users (the bot's `bans` table, keyed by Discord id) can't use the site.
	// Send every authenticated request to /banned — except the /banned page itself,
	// logout (so they can leave), and static assets (so /banned can render). The read
	// is a synchronous lookup against the TTL-cached bans table (refreshed above), so
	// it costs zero round-trips; a new ban takes effect within the cache TTL (~30s) on
	// machines other than the one that issued it (ban/unban actions force-refresh).
	const path = event.url.pathname;
	// Populate locals.ban for EVERY authenticated request (the lookup is a zero-cost
	// synchronous cache read), so server loads/endpoints can see it. Only the redirect
	// is skipped for static assets — otherwise /banned couldn't load its own assets.
	event.locals.ban = session?.user ? getBanCached(session.user.discord_id) : null;
	if (event.locals.ban && !isStaticAsset(path)) {
		const allowed = path === '/banned' || path.startsWith('/auth/logout');
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

	// Any non-GET (form actions are how users mutate their own profile) drops this
	// session's cached user, so the next request re-reads it fresh from the DB.
	if (event.request.method !== 'GET' && event.locals.sessionId) {
		invalidateSessionCache(event.locals.sessionId);
	}

	if (audit && payload) void logAudit(event, response.status, payload);

	return response;
};

// Unexpected server errors: always log the full error (Fly logs), and on STAGING
// only, return the real message + stack in the response body so failures are
// debuggable from the browser's Network tab. Prod keeps the opaque default —
// stack traces must never leak to members.
export const handleError: HandleServerError = ({ error, event, status, message }) => {
	console.error(
		'[unhandled]',
		event.request.method,
		event.url.pathname + event.url.search,
		status,
		error
	);
	if (STAGING_ADMIN_ONLY) {
		const detail =
			error instanceof Error ? `${error.message}\n\n${error.stack ?? ''}` : String(error);
		return { message: detail };
	}
	return { message };
};
