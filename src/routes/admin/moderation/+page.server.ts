import { redirect, error, fail } from '@sveltejs/kit';
import { db, fetchAllFiltered } from '$lib/server/db';
import { isAdmin } from '$lib/server/auth';
import type { Actions, PageServerLoad } from './$types';

// Admin moderation hub — manage the bot's `bans` + `warnings` tables (shared
// Supabase project). Bans block site access (see hooks.server.ts + /banned) and
// are used by the bot to kick/keep-out on Discord. Both are keyed by Discord id.
// (Assumes both tables have an `id` PK for per-warning deletes — the Supabase
// default; unbans delete by discord_id so they don't rely on it.)

interface BanRow {
	id: string | number;
	discord_id: string;
	username: string | null;
	reason: string | null;
	banned_by_tag: string | null;
	created_at: string | null;
}

interface WarnRow {
	id: string | number;
	discord_id: string;
	username: string | null;
	reason: string | null;
	warned_by_tag: string | null;
	created_at: string | null;
	expires_at: string | null;
}

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

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) throw redirect(303, '/');
	if (!isAdmin(locals.user)) throw error(403, 'Not allowed');

	const sb = db();
	const [bansRes, warnsRes, usersRes, playersRes] = await Promise.all([
		sb
			.from('bans')
			.select('id, discord_id, username, reason, banned_by_tag, created_at')
			.order('created_at', { ascending: false }),
		sb
			.from('warnings')
			.select('id, discord_id, username, reason, warned_by_tag, created_at, expires_at')
			.order('created_at', { ascending: false }),
		fetchAllFiltered((f, t) =>
			sb.from('vs_users').select('discord_id, rsn, discord_username').not('discord_id', 'is', null).range(f, t)
		),
		fetchAllFiltered((f, t) => sb.from('players').select('discord_id, rsn').not('discord_id', 'is', null).range(f, t))
	]);

	const now = Date.now();
	const bans = ((bansRes.data ?? []) as BanRow[]).map((b) => ({
		id: b.id,
		discord_id: b.discord_id,
		name: b.username || b.discord_id,
		reason: b.reason,
		by: b.banned_by_tag,
		at: b.created_at
	}));
	const warnings = ((warnsRes.data ?? []) as WarnRow[]).map((w) => ({
		id: w.id,
		discord_id: w.discord_id,
		name: w.username || w.discord_id,
		reason: w.reason,
		by: w.warned_by_tag,
		at: w.created_at,
		active: w.expires_at ? new Date(w.expires_at).getTime() > now : true
	}));

	// Member picker (site users + roster, deduped by Discord id).
	const byId = new Map<string, string>();
	for (const u of (usersRes.data ?? []) as Array<{
		discord_id: string | null;
		rsn: string | null;
		discord_username: string | null;
	}>) {
		if (u.discord_id) byId.set(u.discord_id, u.rsn || u.discord_username || u.discord_id);
	}
	for (const p of (playersRes.data ?? []) as Array<{ discord_id: string | null; rsn: string | null }>) {
		if (p.discord_id && !byId.has(p.discord_id)) byId.set(p.discord_id, p.rsn || p.discord_id);
	}
	const members = Array.from(byId, ([discord_id, label]) => ({ discord_id, label })).sort((a, b) =>
		a.label.localeCompare(b.label, undefined, { sensitivity: 'base' })
	);

	return { bans, warnings, members };
};

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
		return { ok: true, action: 'ban' as const };
	},

	unbanUser: async ({ locals, request }) => {
		if (!locals.user || !isAdmin(locals.user)) return fail(403, { error: 'Not allowed' });
		const form = await request.formData();
		const discordId = form.get('discord_id')?.toString();
		if (!discordId) return fail(400, { error: 'Missing discord_id' });
		const { error: delErr } = await db().from('bans').delete().eq('discord_id', discordId);
		if (delErr) return fail(500, { error: delErr.message });
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
