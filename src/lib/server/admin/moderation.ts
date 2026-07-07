import { db, fetchAllFiltered } from '$lib/server/db';

// Data for /admin/moderation — the bot's `bans` + `warnings` tables (shared
// Supabase project) plus the member picker. Bans block site access (see
// hooks.server.ts + /banned) and are used by the bot to kick/keep-out on
// Discord. Both are keyed by Discord id.

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

export async function buildModeration() {
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
}
