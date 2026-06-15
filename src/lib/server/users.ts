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
function rsnExactPattern(rsn: string): string {
	return rsn.trim().replace(/_/g, ' ').replace(/[\\%_]/g, '\\$&');
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
