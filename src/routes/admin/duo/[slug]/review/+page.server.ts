import { redirect, error, fail } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { isAdmin } from '$lib/server/auth';
import { renderMarkdown } from '$lib/markdown';
import {
	DUO_WOLF_EVENT_SLUG,
	DUO_TILE_IDS,
	getDuoTileName,
	getDuoTileImg,
	getDuoTileFaq,
	getDuoTileRequired
} from '$lib/server/duoWolfTiles';
import type { Actions, PageServerLoad } from './$types';

interface PendingRow {
	id: string;
	team_id: string;
	tile_id: string;
	proof_urls: string[] | null;
	submitted_at: string;
	status: 'pending' | 'approved' | 'rejected';
	vs_users: { rsn: string | null; discord_username: string } | null;
	team: { id: string; name: string | null } | null;
}

function faqToHtml(faq: string | null): string | null {
	if (!faq) return null;
	return renderMarkdown(faq.replace(/(?<!\n)\n(?!\n)/g, '  \n'));
}

function requireDuoWolf(slug: string): void {
	if (slug !== DUO_WOLF_EVENT_SLUG) throw error(404, 'Not found');
}

async function fetchEvent(slug: string) {
	const { data, error: qErr } = await db()
		.from('vs_events')
		.select('id, slug, name, status')
		.eq('slug', slug)
		.maybeSingle();
	if (qErr) throw error(500, qErr.message);
	return data;
}

export const load: PageServerLoad = async ({ params, locals }) => {
	if (!locals.user) throw redirect(303, '/');
	if (!isAdmin(locals.user)) throw error(403, 'Not allowed');
	requireDuoWolf(params.slug);

	const event = await fetchEvent(params.slug);
	if (!event) throw error(404, 'Event not found');

	const { data: pendingRaw, error: qErr } = await db()
		.from('vs_team_completions')
		.select(
			'id, team_id, tile_id, proof_urls, submitted_at, status, vs_users!user_id(rsn, discord_username), team:vs_teams!team_id(id, name)'
		)
		.eq('event_id', event.id)
		.eq('status', 'pending')
		.order('submitted_at', { ascending: true });
	if (qErr) throw error(500, qErr.message);

	const pending = (pendingRaw ?? []) as unknown as PendingRow[];

	// Approved-so-far per (team, tile) so the reviewer sees "approving makes it N/M".
	const { data: approvedRaw } = await db()
		.from('vs_team_completions')
		.select('team_id, tile_id')
		.eq('event_id', event.id)
		.eq('status', 'approved');
	const approvedCountByKey = new Map<string, number>();
	for (const r of (approvedRaw ?? []) as { team_id: string; tile_id: string }[]) {
		const k = `${r.team_id}|${r.tile_id}`;
		approvedCountByKey.set(k, (approvedCountByKey.get(k) ?? 0) + 1);
	}

	interface PendingGroup {
		team_id: string;
		tile_id: string;
		team_name: string;
		tile: { id: string; name: string; img: string | null; faq_html: string | null; required: number };
		approved: number;
		submissions: Array<{
			id: string;
			proof_urls: string[];
			submitted_at: string;
			submitted_by: string;
		}>;
	}

	const groupsMap = new Map<string, PendingGroup>();
	for (const row of pending) {
		if (!DUO_TILE_IDS.has(row.tile_id)) continue;
		const key = `${row.team_id}|${row.tile_id}`;
		let group = groupsMap.get(key);
		if (!group) {
			group = {
				team_id: row.team_id,
				tile_id: row.tile_id,
				team_name: row.team?.name ?? 'Unnamed team',
				tile: {
					id: row.tile_id,
					name: getDuoTileName(row.tile_id) ?? row.tile_id,
					img: getDuoTileImg(row.tile_id),
					faq_html: faqToHtml(getDuoTileFaq(row.tile_id)),
					required: getDuoTileRequired(row.tile_id)
				},
				approved: approvedCountByKey.get(key) ?? 0,
				submissions: []
			};
			groupsMap.set(key, group);
		}
		group.submissions.push({
			id: row.id,
			proof_urls: row.proof_urls ?? [],
			submitted_at: row.submitted_at,
			submitted_by: row.vs_users ? (row.vs_users.rsn ?? row.vs_users.discord_username) : 'unknown'
		});
	}

	const groups = Array.from(groupsMap.values());

	const { count: approvedCount } = await db()
		.from('vs_team_completions')
		.select('id', { count: 'exact', head: true })
		.eq('event_id', event.id)
		.eq('status', 'approved');
	const { count: rejectedCount } = await db()
		.from('vs_team_completions')
		.select('id', { count: 'exact', head: true })
		.eq('event_id', event.id)
		.eq('status', 'rejected');

	return {
		event: { name: event.name, slug: event.slug },
		groups,
		stats: {
			pendingGroups: groups.length,
			pendingSubmissions: pending.length,
			approved: approvedCount ?? 0,
			rejected: rejectedCount ?? 0
		}
	};
};

async function updateGroupStatus({
	eventId,
	teamId,
	tileId,
	reviewerId,
	newStatus,
	note
}: {
	eventId: string;
	teamId: string;
	tileId: string;
	reviewerId: string;
	newStatus: 'approved' | 'rejected';
	note: string | null;
}) {
	return db()
		.from('vs_team_completions')
		.update({
			status: newStatus,
			reviewed_at: new Date().toISOString(),
			reviewed_by: reviewerId,
			review_note: note
		})
		.eq('event_id', eventId)
		.eq('team_id', teamId)
		.eq('tile_id', tileId)
		.eq('status', 'pending');
}

export const actions: Actions = {
	approve: async ({ params, locals, request }) => {
		if (!locals.user) throw redirect(303, '/');
		if (!isAdmin(locals.user)) return fail(403, { error: 'Not allowed' });
		requireDuoWolf(params.slug);

		const event = await fetchEvent(params.slug);
		if (!event) return fail(404, { error: 'Event not found' });

		const form = await request.formData();
		const teamId = form.get('team_id')?.toString() ?? '';
		const tileId = form.get('tile_id')?.toString() ?? '';
		if (!teamId || !tileId) return fail(400, { error: 'Missing team_id / tile_id' });

		const { error: upErr } = await updateGroupStatus({
			eventId: event.id,
			teamId,
			tileId,
			reviewerId: locals.user.id,
			newStatus: 'approved',
			note: null
		});
		if (upErr) return fail(500, { error: upErr.message });

		return { ok: true, action: 'approve' as const, team_id: teamId, tile_id: tileId };
	},

	reject: async ({ params, locals, request }) => {
		if (!locals.user) throw redirect(303, '/');
		if (!isAdmin(locals.user)) return fail(403, { error: 'Not allowed' });
		requireDuoWolf(params.slug);

		const event = await fetchEvent(params.slug);
		if (!event) return fail(404, { error: 'Event not found' });

		const form = await request.formData();
		const teamId = form.get('team_id')?.toString() ?? '';
		const tileId = form.get('tile_id')?.toString() ?? '';
		const note = form.get('note')?.toString().trim() || null;
		if (!teamId || !tileId) return fail(400, { error: 'Missing team_id / tile_id' });

		const { error: upErr } = await updateGroupStatus({
			eventId: event.id,
			teamId,
			tileId,
			reviewerId: locals.user.id,
			newStatus: 'rejected',
			note
		});
		if (upErr) return fail(500, { error: upErr.message });

		return { ok: true, action: 'reject' as const, team_id: teamId, tile_id: tileId };
	}
};
