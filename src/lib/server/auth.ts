import type { Cookies } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { db } from './db';

const SESSION_COOKIE = 'vs_session';
const SESSION_TTL_DAYS = 30;

export interface SessionUser {
	id: string;
	discord_id: string;
	discord_username: string;
	rsn: string | null;
	clan_allegiance: string | null;
	account_type: string | null;
	welcome_pack_granted: boolean;
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

export async function readSession(
	cookies: Cookies
): Promise<{ user: SessionUser; sessionId: string } | null> {
	const sessionId = cookies.get(SESSION_COOKIE);
	if (!sessionId) return null;

	const { data, error } = await db()
		.from('vs_sessions')
		.select(
			'id, expires_at, vs_users(id, discord_id, discord_username, rsn, clan_allegiance, account_type, welcome_pack_granted)'
		)
		.eq('id', sessionId)
		.maybeSingle();

	if (error || !data) return null;

	if (new Date(data.expires_at) < new Date()) {
		await destroySession(cookies);
		return null;
	}

	const user = data.vs_users as unknown as SessionUser | null;
	if (!user) return null;

	return { user, sessionId: data.id };
}

export async function destroySession(cookies: Cookies): Promise<void> {
	const sessionId = cookies.get(SESSION_COOKIE);
	if (sessionId) {
		await db().from('vs_sessions').delete().eq('id', sessionId);
	}
	cookies.delete(SESSION_COOKIE, { path: '/' });
}

export function isAdmin(user: SessionUser | null): boolean {
	if (!user) return false;
	const adminIds = (env.ADMIN_DISCORD_IDS ?? '')
		.split(',')
		.map((s) => s.trim())
		.filter(Boolean);
	return adminIds.includes(user.discord_id);
}

// Separate allow-list (env var CARD_TESTER_DISCORD_IDS) for the card game. A card
// tester has FULL access (create/edit/delete cards & packs). Intentionally
// INDEPENDENT of ADMIN_DISCORD_IDS for that full access.
export function isCardTester(user: SessionUser | null): boolean {
	if (!user) return false;
	const ids = (env.CARD_TESTER_DISCORD_IDS ?? '')
		.split(',')
		.map((s) => s.trim())
		.filter(Boolean);
	return ids.includes(user.discord_id);
}

// VIEW-level access to the Cards & Packs admin area: general admins may open it
// (read-only card/pack editors + the grant/test/sim/stats tools), while editing the
// catalog still requires the card-tester role (isCardTester). Either role qualifies.
export function isCardAdmin(user: SessionUser | null): boolean {
	return isAdmin(user) || isCardTester(user);
}
