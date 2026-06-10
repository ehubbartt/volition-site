import { redirect, error, fail } from '@sveltejs/kit';
import { z } from 'zod';
import { db } from '$lib/server/db';
import { isAdmin } from '$lib/server/auth';
import { ensureWelcomePack } from '$lib/server/welcomePack';
import { loadCalendarItems } from '$lib/server/calendar';
import { loadPlayerTasks } from '$lib/server/tasks';
import { CATEGORY_OPTIONS } from '$lib/calendar';
import { RANK_ORDER, RANK_LABEL, RANK_COLOR, rankIndex } from '$lib/ranks';
import type { Actions, PageServerLoad } from './$types';

// The Volition clan roster lives in the bot's `players` table (this bot is
// Volition's). The home page's member-facing sections (count, lookup,
// recently-joined, rank breakdown) read from it — NOT vs_users, which also holds
// other-clan members who signed in for cross-clan events.
interface PlayerRow {
	id: number;
	rsn: string;
	discord_id: string | null;
	rank: string | null;
	points: number | null;
	clan_joined_at: string | null;
	created_at: string | null;
}

interface SiteUserRow {
	discord_id: string | null;
	rsn: string | null;
}

interface EventStatusRow {
	status: string;
}

function eventCounts(rows: EventStatusRow[]) {
	const active = rows.filter((r) => r.status === 'open' || r.status === 'locked').length;
	return { active, total: rows.length };
}

// Mirrors users.ts rsnExactPattern normalization (OSRS treats space/underscore as
// equal), so a roster rsn can be matched against a site rsn case/spacing-insensitively.
function normRsn(rsn: string | null | undefined): string {
	return (rsn ?? '').trim().replace(/_/g, ' ').toLowerCase();
}

export const load: PageServerLoad = async ({ parent }) => {
	// Read the user from the layout load (single source of truth) rather than
	// resolving it again here. Returning our own `user` key would clobber the
	// layout's and let the two diverge — that's how a stale client after a deploy
	// ends up with a logged-in nav but a "please sign in" page body.
	const { user } = await parent();
	const sb = db();

	// Logged out → public landing (hero + a light upcoming teaser + headline stats).
	if (!user) {
		const [calendar, playersRes, eventsRes] = await Promise.all([
			loadCalendarItems(false),
			sb.from('players').select('id', { count: 'exact', head: true }),
			sb.from('vs_events').select('status').in('status', ['open', 'locked', 'closed'])
		]);
		const { active, total } = eventCounts((eventsRes.data ?? []) as EventStatusRow[]);
		return {
			calendar,
			members: [] as never[],
			rankBreakdown: [] as never[],
			recentMembers: [] as never[],
			stats: { members: playersRes.count ?? 0, activeEvents: active, totalEvents: total, packsOpened: 0 },
			taskSummary: null,
			categoryOptions: CATEGORY_OPTIONS
		};
	}

	// Logged in but not onboarded → finish onboarding first.
	if (!user.rsn || !user.clan_allegiance || !user.account_type) {
		throw redirect(303, '/onboarding');
	}

	const admin = isAdmin(user);

	const [calendar, playersRes, siteUsersRes, eventsRes, packsRes, tasks] = await Promise.all([
		loadCalendarItems(admin),
		sb
			.from('players')
			.select('id, rsn, discord_id, rank, points, clan_joined_at, created_at'),
		sb.from('vs_users').select('discord_id, rsn').not('rsn', 'is', null),
		sb.from('vs_events').select('status').in('status', ['draft', 'preview', 'open', 'locked', 'closed']),
		sb.from('vs_pack_opens').select('id', { count: 'exact', head: true }),
		// To-do surface is open to all onboarded users — always aggregate it.
		loadPlayerTasks(user)
	]);

	// Ship a light summary (not the full array) for the home "Your to-do" card.
	const taskSummary = tasks
		? {
				todoCount: tasks.filter((t) => t.status === 'todo').length,
				total: tasks.length,
				hasActive: tasks.some((t) => t.status === 'active')
			}
		: null;

	const playerRows = (playersRes.data ?? []) as PlayerRow[];
	const siteUsers = (siteUsersRes.data ?? []) as SiteUserRow[];

	// Which roster members have a site profile (→ /u/[rsn] is reachable). Match on
	// discord_id first, then normalized rsn.
	const siteDiscordIds = new Set(siteUsers.map((u) => u.discord_id).filter(Boolean) as string[]);
	const siteRsns = new Set(siteUsers.map((u) => normRsn(u.rsn)).filter(Boolean));
	const hasProfile = (p: PlayerRow) =>
		(p.discord_id != null && siteDiscordIds.has(p.discord_id)) || siteRsns.has(normRsn(p.rsn));

	// Welcome pack: if this member hasn't received theirs yet and is now in the
	// Volition roster (e.g. they signed up before joining, then joined), grant it.
	// Reuses the roster already loaded above, so it's a no-op (no query) once granted.
	if (!user.welcome_pack_granted) {
		const userIsMember = playerRows.some(
			(p) =>
				(p.discord_id != null && p.discord_id === user.discord_id) ||
				normRsn(p.rsn) === normRsn(user.rsn)
		);
		await ensureWelcomePack(
			{
				id: user.id,
				discord_id: user.discord_id,
				rsn: user.rsn,
				welcome_pack_granted: user.welcome_pack_granted
			},
			userIsMember
		);
	}

	const members = playerRows
		.map((p) => ({
			rsn: p.rsn,
			rank: p.rank,
			points: p.points ?? 0,
			joinedAt: p.clan_joined_at ?? p.created_at,
			hasProfile: hasProfile(p)
		}))
		.sort((a, b) => a.rsn.localeCompare(b.rsn, undefined, { sensitivity: 'base' }));

	// Rank breakdown in ladder order; unrecognized / null ranks collapse to one
	// "Unranked" bucket appended at the end.
	const rankCounts = new Map<string, number>();
	let unranked = 0;
	for (const p of playerRows) {
		if (rankIndex(p.rank) === -1) unranked += 1;
		else rankCounts.set(p.rank as string, (rankCounts.get(p.rank as string) ?? 0) + 1);
	}
	const rankBreakdown = RANK_ORDER.filter((r) => (rankCounts.get(r) ?? 0) > 0)
		.map((r) => ({ value: r as string, label: RANK_LABEL[r], color: RANK_COLOR[r], count: rankCounts.get(r) ?? 0 }));
	if (unranked > 0) {
		rankBreakdown.push({ value: 'unranked', label: 'Unranked', color: '#9aa0a6', count: unranked });
	}

	const recentMembers = [...members]
		.filter((m) => m.joinedAt)
		.sort((a, b) => new Date(b.joinedAt!).getTime() - new Date(a.joinedAt!).getTime())
		.slice(0, 5);

	const { active, total } = eventCounts((eventsRes.data ?? []) as EventStatusRow[]);

	return {
		calendar,
		members,
		rankBreakdown,
		recentMembers,
		stats: {
			members: playerRows.length,
			activeEvents: active,
			totalEvents: total,
			packsOpened: packsRes.count ?? 0
		},
		taskSummary,
		categoryOptions: CATEGORY_OPTIONS
	};
};

const CATEGORY_VALUES = CATEGORY_OPTIONS.map((c) => c.value) as [string, ...string[]];

const entrySchema = z.object({
	title: z.string().trim().min(1).max(120),
	description: z.string().trim().max(2000).optional().nullable(),
	starts_at: z.string().trim().min(1, 'Start date/time is required'),
	ends_at: z.string().trim().optional().nullable(),
	location: z.string().trim().max(120).optional().nullable(),
	link_url: z.string().trim().max(500).optional().nullable(),
	category: z.enum(CATEGORY_VALUES)
});

function normalizeDate(v: FormDataEntryValue | null): string | null {
	const s = v?.toString().trim();
	if (!s) return null;
	const d = new Date(s);
	if (Number.isNaN(d.getTime())) return null;
	return d.toISOString();
}

function parseEntry(form: FormData) {
	return entrySchema.safeParse({
		title: form.get('title'),
		description: form.get('description') || null,
		starts_at: form.get('starts_at'),
		ends_at: form.get('ends_at') || null,
		location: form.get('location') || null,
		link_url: form.get('link_url') || null,
		category: form.get('category') ?? 'event'
	});
}

export const actions: Actions = {
	createCalendarEntry: async ({ locals, request }) => {
		if (!locals.user || !isAdmin(locals.user)) throw error(403, 'Not allowed');

		const form = await request.formData();
		const parsed = parseEntry(form);
		if (!parsed.success) {
			return fail(400, { error: parsed.error.issues[0]?.message ?? 'Invalid input' });
		}

		const startsAt = normalizeDate(form.get('starts_at'));
		if (!startsAt) return fail(400, { error: 'Invalid start date/time' });

		const { error: insertError } = await db().from('vs_calendar_events').insert({
			title: parsed.data.title,
			description: parsed.data.description,
			starts_at: startsAt,
			ends_at: normalizeDate(form.get('ends_at')),
			location: parsed.data.location,
			link_url: parsed.data.link_url,
			category: parsed.data.category,
			created_by: locals.user.id
		});

		if (insertError) return fail(500, { error: insertError.message });
		return { ok: true, action: 'create' };
	},

	updateCalendarEntry: async ({ locals, request }) => {
		if (!locals.user || !isAdmin(locals.user)) throw error(403, 'Not allowed');

		const form = await request.formData();
		const id = form.get('id')?.toString();
		if (!id) return fail(400, { error: 'Missing id' });

		const parsed = parseEntry(form);
		if (!parsed.success) {
			return fail(400, { error: parsed.error.issues[0]?.message ?? 'Invalid input' });
		}

		const startsAt = normalizeDate(form.get('starts_at'));
		if (!startsAt) return fail(400, { error: 'Invalid start date/time' });

		const { error: updateError } = await db()
			.from('vs_calendar_events')
			.update({
				title: parsed.data.title,
				description: parsed.data.description,
				starts_at: startsAt,
				ends_at: normalizeDate(form.get('ends_at')),
				location: parsed.data.location,
				link_url: parsed.data.link_url,
				category: parsed.data.category,
				updated_at: new Date().toISOString()
			})
			.eq('id', id);

		if (updateError) return fail(500, { error: updateError.message });
		return { ok: true, action: 'update' };
	},

	deleteCalendarEntry: async ({ locals, request }) => {
		if (!locals.user || !isAdmin(locals.user)) throw error(403, 'Not allowed');

		const form = await request.formData();
		const id = form.get('id')?.toString();
		if (!id) return fail(400, { error: 'Missing id' });

		const { error: deleteError } = await db().from('vs_calendar_events').delete().eq('id', id);
		if (deleteError) return fail(500, { error: deleteError.message });
		return { ok: true, action: 'delete' };
	}
};
