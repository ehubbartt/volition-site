import { db } from './db';

// The bot owns the `bans` table (see voli-disc-bot: db/supabase.js getBan/createBan,
// commands/utility/ban.js). A user is banned from the Discord — and now the site —
// if a row exists for their Discord id. Columns: discord_id, username, reason,
// banned_by, banned_by_tag, created_at.
export interface Ban {
	discord_id: string;
	reason: string | null;
	created_at: string | null;
}

// Returns the ban row for a Discord id, or null if they're not banned. Best-effort:
// a DB error returns null (fail-open) so an outage doesn't lock everyone out.
export async function getBan(discordId: string | null): Promise<Ban | null> {
	if (!discordId) return null;
	const { data, error } = await db()
		.from('bans')
		.select('discord_id, reason, created_at')
		.eq('discord_id', discordId)
		.maybeSingle();
	if (error) return null;
	return (data as Ban | null) ?? null;
}
