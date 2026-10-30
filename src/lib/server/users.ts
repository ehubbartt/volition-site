import { db } from './db';
import { slugToRsn } from '$lib/rsn';

export interface ProfileUser {
	id: string;
	discord_id: string;
	discord_username: string;
	rsn: string | null;
	clan_allegiance: string | null;
	account_type: string | null;
}

// Builds a wildcard-safe ILIKE pattern for an exact, case-insensitive RSN match.
// OSRS treats space and underscore as the same character, so we normalise '_' to
// ' ' first; then we escape the LIKE metacharacters (% _ \) so the lookup is an
// exact match, not a pattern (a stray '_' in input would otherwise match any char).
// Exported so every `ilike('rsn', …)` lookup (players + vs_users) shares one escape.
export function rsnExactPattern(rsn: string): string {
	return rsn.trim().replace(/_/g, ' ').replace(/[\\%_]/g, '\\$&');
}

// One comparison key per name: lowercase, with any run of space / hyphen / underscore folded
// to one space — OSRS treats all three as the same character. Sources disagree on which they
// use: Dink sends the real in-game spelling ("Chest X-Ray"), WiseOldMan (and so the roster and
// most profiles) folds hyphens into spaces ("Chest X Ray").
export function rsnKey(rsn: string): string {
	return rsn.toLowerCase().replace(/[\s_-]+/g, ' ').trim();
}

// ILIKE pattern that matches an RSN with ANY single separator character where it has a
// space / hyphen / underscore. Deliberately a little wide (the wildcard admits any char) —
// callers re-check candidates with rsnKey to keep only a true match.
export function rsnLoosePattern(rsn: string): string {
	return rsnKey(rsn)
		.split(' ')
		.map((part) => part.replace(/[\\%_]/g, '\\$&'))
		.join('_');
}

// A site user id for an RSN, matching it however its separators are spelled (see rsnKey).
// ILIKE narrows the candidates — each separator becomes a one-character wildcard — and the
// key comparison then keeps only a true match, so the wildcard can't admit a different name.
export async function findUserIdByRsnLoose(rsn: string): Promise<string | null> {
	const key = rsnKey(rsn);
	if (!key) return null;
	const { data } = await db().from('vs_users').select('id, rsn').ilike('rsn', rsnLoosePattern(rsn)).limit(10);
	const hit = ((data ?? []) as { id: string; rsn: string | null }[]).find((u) => u.rsn && rsnKey(u.rsn) === key);
	return hit?.id ?? null;
}

// Resolve a /u/[rsn] slug to its vs_users row (case-insensitive). Returns null if
// no such player. RSNs are unique (see isRsnTaken), so at most one matches.
export async function findUserBySlug(slug: string): Promise<ProfileUser | null> {
	const rsn = slugToRsn(slug);
	if (!rsn) return null;

	const { data } = await db()
		.from('vs_users')
		.select('id, discord_id, discord_username, rsn, clan_allegiance, account_type')
		.ilike('rsn', rsnExactPattern(rsn))
		.limit(1)
		.maybeSingle();

	return (data as ProfileUser | null) ?? null;
}

// True if some OTHER user already has this RSN (case-insensitive, treating space
// and underscore as equivalent). Used to enforce RSN uniqueness on onboarding and
// profile edits, since profile URLs key off the RSN.
export async function isRsnTaken(rsn: string, exceptUserId?: string): Promise<boolean> {
	let q = db().from('vs_users').select('id').ilike('rsn', rsnExactPattern(rsn)).limit(1);
	if (exceptUserId) q = q.neq('id', exceptUserId);
	const { data } = await q;
	return !!(data && data.length > 0);
}
