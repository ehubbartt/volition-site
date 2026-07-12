import type { Cookies } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { db } from './db';
import { dbAdminIds, dbCardTesterIds } from './adminRoles';

const SESSION_COOKIE = 'vs_session';
const SESSION_TTL_DAYS = 30;

// "View as" (super-admin only, see hooks.server.ts): when set, every role check
// answers AS THAT ROLE, so a super admin can preview the site as a plain admin,
// a regular member, or a non-clan-member ('guest'). Applied only in hooks after
// verifying the REAL session user is a super admin, so it can only ever REDUCE
// privileges — it never grants anything the real user doesn't already have.
export type ViewAsRole = 'admin' | 'member' | 'guest';

export interface SessionUser {
	id: string;
	discord_id: string;
	discord_username: string;
	rsn: string | null;
	clan_allegiance: string | null;
	account_type: string | null;
	welcome_pack_granted: boolean;
	view_as?: ViewAsRole;
}

function randomToken(bytes = 32): string {
	const arr = new Uint8Array(bytes);
	crypto.getRandomValues(arr);
	return Array.from(arr, (b) => b.toString(16).padStart(2, '0')).join('');
}

export async function createSession(userId: string, cookies: Cookies): Promise<string> {
	const id = randomToken();
	const expiresAt = new Date(Date.now() + SESSION_TTL_DAYS * 24 * 60 * 60 * 1000);

	const { error } = await db()
		.from('vs_sessions')
		.insert({ id, user_id: userId, expires_at: expiresAt.toISOString() });

	if (error) throw new Error(`Failed to create session: ${error.message}`);

	cookies.set(SESSION_COOKIE, id, {
		path: '/',
		httpOnly: true,
		secure: process.env.NODE_ENV === 'production',
		sameSite: 'lax',
		expires: expiresAt
	});

	return id;
}

// In-memory session cache: the session→user lookup runs in hooks.server.ts on
// EVERY request, and after the role/ban caches it was the last per-request DB
// round-trip gating every navigation. Entries live for a short TTL and are
// dropped on logout and after ANY non-GET from that session (hooks.server.ts) —
// form actions are the only way a user mutates their own profile, so edits like
// onboarding/RSN changes are always re-read immediately. A user's welcome-pack
// flag can be briefly stale, which is safe: ensureWelcomePack claims atomically.
const SESSION_CACHE_TTL_MS = 60_000;
type CachedSession = { user: SessionUser; expiresAt: number; cachedAt: number };
const sessionCache = new Map<string, CachedSession>();

export function invalidateSessionCache(sessionId: string | null | undefined): void {
	if (sessionId) sessionCache.delete(sessionId);
}

export async function readSession(
	cookies: Cookies
): Promise<{ user: SessionUser; sessionId: string } | null> {
	const sessionId = cookies.get(SESSION_COOKIE);
	if (!sessionId) return null;

	const now = Date.now();
	const cached = sessionCache.get(sessionId);
	if (cached && now - cached.cachedAt < SESSION_CACHE_TTL_MS) {
		if (cached.expiresAt < now) {
			await destroySession(cookies);
			return null;
		}
		return { user: cached.user, sessionId };
	}

	const { data, error } = await db()
		.from('vs_sessions')
		.select(
			'id, expires_at, vs_users(id, discord_id, discord_username, rsn, clan_allegiance, account_type, welcome_pack_granted)'
		)
		.eq('id', sessionId)
		.maybeSingle();

	if (error || !data) {
		sessionCache.delete(sessionId);
		return null;
	}

	if (new Date(data.expires_at) < new Date()) {
		await destroySession(cookies);
		return null;
	}

	const user = data.vs_users as unknown as SessionUser | null;
	if (!user) return null;

	sessionCache.set(sessionId, {
		user,
		expiresAt: new Date(data.expires_at).getTime(),
		cachedAt: now
	});
	return { user, sessionId: data.id };
}

export async function destroySession(cookies: Cookies): Promise<void> {
	const sessionId = cookies.get(SESSION_COOKIE);
	if (sessionId) {
		sessionCache.delete(sessionId);
		await db().from('vs_sessions').delete().eq('id', sessionId);
	}
	cookies.delete(SESSION_COOKIE, { path: '/' });
}

function envIds(raw: string | undefined): string[] {
	return (raw ?? '')
		.split(',')
		.map((s) => s.trim())
		.filter(Boolean);
}

// Admin access is the union of three sources:
//   1. ADMIN_DISCORD_IDS env var (the original, deploy-time allow-list)
//   2. owners (super admins always count as admins)
//   3. DB grants from vs_admin_roles, managed by owners at /admin/admins
// The DB set is read synchronously from a per-request cache (see adminRoles.ts);
// hooks.server.ts refreshes it before any permission check runs.
export function isAdmin(user: SessionUser | null): boolean {
	if (!user) return false;
	// View-as override: 'admin' previews as a plain admin; 'member'/'guest' drop it.
	if (user.view_as) return user.view_as === 'admin';
	if (envIds(env.ADMIN_DISCORD_IDS).includes(user.discord_id)) return true;
	if (isSuperAdmin(user)) return true;
	return dbAdminIds().has(user.discord_id);
}

// Separate allow-list (env var CARD_TESTER_DISCORD_IDS) for the card game. A card
// tester has FULL access (create/edit/delete cards & packs). Intentionally
// INDEPENDENT of ADMIN_DISCORD_IDS for that full access. Owners may also grant the
// card_tester role from /admin/admins (merged via the DB cache).
export function isCardTester(user: SessionUser | null): boolean {
	if (!user) return false;
	// View-as override: none of the preview roles carry the card-tester grant.
	if (user.view_as) return false;
	if (envIds(env.CARD_TESTER_DISCORD_IDS).includes(user.discord_id)) return true;
	return dbCardTesterIds().has(user.discord_id);
}

// VIEW-level access to the Cards & Packs admin area: general admins may open it
// (read-only card/pack editors + the grant/test/sim/stats tools), while editing the
// catalog still requires the card-tester role (isCardTester). Either role qualifies.
export function isCardAdmin(user: SessionUser | null): boolean {
	return isAdmin(user) || isCardTester(user);
}

// Highest-privilege allow-list (env var SUPER_ADMIN_DISCORD_IDS) for the destructive
// dashboard tools migrated from volition-admin-dashboard: the generic DB table editor
// and the bot config editor. These read/write ANY table (incl. the bot's), so they're
// gated to a small set of people, SEPARATE from ADMIN_DISCORD_IDS. Independent list.
export function isSuperAdmin(user: SessionUser | null): boolean {
	if (!user) return false;
	// View-as override: every preview role is below super admin.
	if (user.view_as) return false;
	return envIds(env.SUPER_ADMIN_DISCORD_IDS).includes(user.discord_id);
}

// Env-rooted allow-lists, exposed for the owner UI at /admin/admins so it can show
// them as read-only ("root — not removable"). These can only be changed by editing
// env vars + redeploying; the UI manages the DB grants instead.
export function envAdminIds(): string[] {
	return envIds(env.ADMIN_DISCORD_IDS);
}
export function envSuperAdminIds(): string[] {
	return envIds(env.SUPER_ADMIN_DISCORD_IDS);
}
export function envCardTesterIds(): string[] {
	return envIds(env.CARD_TESTER_DISCORD_IDS);
}
