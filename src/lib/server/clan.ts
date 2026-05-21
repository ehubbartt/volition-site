import { db } from './db';

// Cross-references the bot's `players` table to verify a site user is an
// actual clan member. Matches by discord_id first, falls back to RSN
// (case-insensitive) since not every player row has a linked Discord.
export async function isClanMember(
	discordId: string | null,
	rsn: string | null
): Promise<boolean> {
	const sb = db();

	if (discordId) {
		const { data, error } = await sb
			.from('players')
			.select('rsn')
			.eq('discord_id', discordId)
			.limit(1);
		if (!error && data && data.length > 0) return true;
	}

	if (rsn) {
		const { data, error } = await sb
			.from('players')
			.select('rsn')
			.ilike('rsn', rsn)
			.limit(1);
		if (!error && data && data.length > 0) return true;
	}

	return false;
}
