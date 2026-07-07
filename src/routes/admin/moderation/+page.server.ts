import { fail } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { isAdmin } from '$lib/server/auth';
import { ensureFreshBans } from '$lib/server/bansCache';
import type { Actions } from './$types';

// Admin moderation hub — manage the bot's `bans` + `warnings` tables (shared
// Supabase project). Bans block site access (see hooks.server.ts + /banned) and
// are used by the bot to kick/keep-out on Discord. Both are keyed by Discord id.
// (Assumes both tables have an `id` PK for per-warning deletes — the Supabase
// default; unbans delete by discord_id so they don't rely on it.)
// The page data itself comes from /api/admin/moderation via the universal load
// in +page.ts (instant navigation) — this module holds the form actions.

const DISCORD_ID = /^\d{5,25}$/;

// Best-effort display name for a Discord id, from the site users then the roster.
async function resolveUsername(discordId: string): Promise<string | null> {
	const sb = db();
	const { data: u } = await sb
		.from('vs_users')
		.select('rsn, discord_username')
		.eq('discord_id', discordId)
		.maybeSingle();
	if (u) return (u.rsn as string | null) || (u.discord_username as string | null) || null;
	const { data: p } = await sb.from('players').select('rsn').eq('discord_id', discordId).maybeSingle();
	return (p?.rsn as string | null) ?? null;
}

export const actions: Actions = {
	banUser: async ({ locals, request }) => {
		if (!locals.user || !isAdmin(locals.user)) return fail(403, { error: 'Not allowed' });
		const form = await request.formData();
		const discordId = form.get('discord_id')?.toString().trim() ?? '';
		const reason = form.get('reason')?.toString().trim() ?? '';
		if (!DISCORD_ID.test(discordId)) return fail(400, { error: 'Enter a valid Discord ID' });
		if (!reason) return fail(400, { error: 'A reason is required' });
		if (discordId === locals.user.discord_id) return fail(400, { error: "You can't ban yourself" });

		const sb = db();
		const { data: existing } = await sb
			.from('bans')
			.select('discord_id')
			.eq('discord_id', discordId)
			.maybeSingle();
		if (existing) return fail(409, { error: 'That user is already banned' });

		const username = await resolveUsername(discordId);
		const { error: insErr } = await sb.from('bans').insert({
			discord_id: discordId,
			username,
			reason,
			banned_by: locals.user.discord_id,
			banned_by_tag: locals.user.discord_username,
			created_at: new Date().toISOString()
		});
		if (insErr) return fail(500, { error: insErr.message });
		// The hook's ban gate reads a TTL cache — force-refresh so this machine
		// enforces the new ban immediately instead of within the TTL.
		await ensureFreshBans(true);
		return { ok: true, action: 'ban' as const };
	},

	unbanUser: async ({ locals, request }) => {
		if (!locals.user || !isAdmin(locals.user)) return fail(403, { error: 'Not allowed' });
		const form = await request.formData();
		const discordId = form.get('discord_id')?.toString();
		if (!discordId) return fail(400, { error: 'Missing discord_id' });
		const { error: delErr } = await db().from('bans').delete().eq('discord_id', discordId);
		if (delErr) return fail(500, { error: delErr.message });
		await ensureFreshBans(true);
		return { ok: true, action: 'unban' as const };
	},

	warnUser: async ({ locals, request }) => {
		if (!locals.user || !isAdmin(locals.user)) return fail(403, { error: 'Not allowed' });
		const form = await request.formData();
		const discordId = form.get('discord_id')?.toString().trim() ?? '';
		const reason = form.get('reason')?.toString().trim() ?? '';
		if (!DISCORD_ID.test(discordId)) return fail(400, { error: 'Enter a valid Discord ID' });
		if (!reason) return fail(400, { error: 'A reason is required' });

		const username = await resolveUsername(discordId);
		const now = new Date();
		const expires = new Date(now);
		expires.setMonth(expires.getMonth() + 6); // mirrors the bot's 6-month expiry
		const { error: insErr } = await db().from('warnings').insert({
			discord_id: discordId,
			username,
			reason,
			warned_by: locals.user.discord_id,
			warned_by_tag: locals.user.discord_username,
			created_at: now.toISOString(),
			expires_at: expires.toISOString()
		});
		if (insErr) return fail(500, { error: insErr.message });
		return { ok: true, action: 'warn' as const };
	},

	removeWarning: async ({ locals, request }) => {
		if (!locals.user || !isAdmin(locals.user)) return fail(403, { error: 'Not allowed' });
		const form = await request.formData();
		const id = form.get('id')?.toString();
		if (!id) return fail(400, { error: 'Missing id' });
		const { error: delErr } = await db().from('warnings').delete().eq('id', id);
		if (delErr) return fail(500, { error: delErr.message });
		return { ok: true, action: 'removeWarning' as const };
	}
};
