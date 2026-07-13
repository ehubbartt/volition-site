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

// Bulk clan-membership filter: given site users (id + discord_id + rsn), returns the
// subset of `id`s that are clan members (present in the bot's `players` table). Matches
// every discord_id in one query, then falls back to a per-user case-insensitive RSN
// check only for those not already matched — mirroring isClanMember's discord-first,
// rsn-fallback logic without an N-query fan-out for the common (discord-linked) case.
export async function filterClanMembers(
	users: { id: string; discord_id: string | null; rsn: string | null }[]
): Promise<Set<string>> {
	const sb = db();
	const members = new Set<string>();
	if (users.length === 0) return members;

	const discordIds = users.map((u) => u.discord_id).filter((d): d is string => !!d);
	if (discordIds.length) {
		const { data } = await sb.from('players').select('discord_id').in('discord_id', discordIds);
		const memberDiscord = new Set((data ?? []).map((r) => (r as { discord_id: string }).discord_id));
		for (const u of users) if (u.discord_id && memberDiscord.has(u.discord_id)) members.add(u.id);
	}

	for (const u of users) {
		if (members.has(u.id) || !u.rsn) continue;
		const { data } = await sb.from('players').select('rsn').ilike('rsn', u.rsn).limit(1);
		if (data && data.length > 0) members.add(u.id);
	}

	return members;
}
