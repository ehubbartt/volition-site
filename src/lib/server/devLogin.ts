import { dev } from '$app/environment';
import { env } from '$env/dynamic/private';
// PUBLIC_SITE_URL carries the public prefix, so it is NOT exposed by $env/dynamic/private
// (that module filters public-prefixed vars out). It has to come from the public module —
// same as hooks.server.ts reads it for the canonical-host guard.
import { env as publicEnv } from '$env/dynamic/public';

// LOCAL-ONLY sign-in shortcut, used by `scripts/preview.mjs` (and by hand) to look at
// real staging data without round-tripping through Discord OAuth. It exists so visual
// checks can run against a signed-in page; it is NOT an auth mechanism.
//
// Two properties make it safe, and both must stay true if you touch this file:
//
//  1. IT GRANTS NOTHING. The route mints an ordinary `vs_sessions` row for an existing
//     `vs_users` row and nothing else. Roles are still resolved the usual way, from the
//     env allow-lists + `vs_admin_roles` (see auth.ts) — so "log in as super admin" only
//     works because that Discord id is already in SUPER_ADMIN_DISCORD_IDS. There is no
//     new privilege path here, just a shorter way to reach an existing one.
//  2. IT CANNOT EXIST IN A DEPLOY. `dev` is a build-time constant that Vite inlines as
//     `false` in every built bundle, so `npm run build` dead-code-eliminates the handler
//     body: prod and staging ship a route that can only 404. The runtime checks below are
//     belt-and-braces on top of that, for the case where someone runs `vite dev` on a
//     server.
//
// The gates are ANDed and deliberately redundant; each one alone is sufficient to keep
// this off in production.
const TRUTHY = /^(1|true|on|yes)$/i;

export function devLoginEnabled(): boolean {
	// (a) Vite dev server only. Statically false in any built deploy, staging included.
	if (!dev) return false;
	// (b) Opt-in flag — absent by default, so even a local `npm run dev` has it off.
	if (!TRUTHY.test((env.DEV_LOGIN ?? '').trim())) return false;
	// (c) Never under a production NODE_ENV.
	if ((process.env.NODE_ENV ?? '').trim().toLowerCase() === 'production') return false;
	// (d) Never on a Fly machine. Fly injects these into every deployed VM, so this
	//     refuses even if someone starts a dev server on one.
	if (env.FLY_APP_NAME || env.FLY_MACHINE_ID || env.FLY_ALLOC_ID) return false;
	// (e) Never when pointed at the production origin. PUBLIC_SITE_URL drives the
	//     canonical-host guard, so an https origin means this is not a local run.
	const site = (publicEnv.PUBLIC_SITE_URL ?? '').trim();
	if (site && !/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i.test(site)) return false;
	return true;
}

// Which account to sign in as: DEV_LOGIN_DISCORD_ID when set, otherwise the first owner
// in SUPER_ADMIN_DISCORD_IDS — i.e. "log me in as me" on a machine that's already
// configured with the owner allow-list.
export function devLoginDiscordId(): string | null {
	const explicit = (env.DEV_LOGIN_DISCORD_ID ?? '').trim();
	if (explicit) return explicit;
	const first = (env.SUPER_ADMIN_DISCORD_IDS ?? '')
		.split(',')
		.map((s) => s.trim())
		.filter(Boolean)[0];
	return first ?? null;
}
