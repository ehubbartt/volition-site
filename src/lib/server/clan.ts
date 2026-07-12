import { db } from './db';
import { rsnExactPattern } from './users';
import type { ViewAsRole } from './auth';

// Cross-references the bot's `players` table to verify a site user is an
// actual clan member. Matches by discord_id first, falls back to RSN
// (case-insensitive) since not every player row has a linked Discord.
// Takes the session user (not bare ids) so the super-admin "view as
// non-clan-member" preview can answer false without touching the DB.
export async function isClanMember(
	user: { discord_id: string | null; rsn: string | null; view_as?: ViewAsRole } | null
): Promise<boolean> {
	if (!user) return false;
	if (user.view_as === 'guest') return false;

	const sb = db();

	if (user.discord_id) {
		const { data, error } = await sb
			.from('players')
			.select('rsn')
			.eq('discord_id', user.discord_id)
			.limit(1);
		if (!error && data && data.length > 0) return true;
	}

	if (user.rsn) {
		const { data, error } = await sb
			.from('players')
			.select('rsn')
			.ilike('rsn', rsnExactPattern(user.rsn))
			.limit(1);
		if (!error && data && data.length > 0) return true;
	}

	return false;
}
