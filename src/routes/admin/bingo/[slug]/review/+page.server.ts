import { redirect, error, fail } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { isAdmin } from '$lib/server/auth';
import { BINGO_EVENT_SLUG } from '$lib/bingo/config';
import { BINGO_TILE_BY_ID, getTileDetails } from '$lib/server/bingoTiles';
import { renderMarkdown } from '$lib/markdown';
import { CLAN_LABEL } from '$lib/clans';
import type { BingoTile } from '$lib/bingo/tiles';
import type { Actions, PageServerLoad } from './$types';

interface PendingRow {
	id: string;
	user_id: string;
	tile_id: string;
	proof_urls: string[] | null;
	submitted_at: string;
	status: 'pending' | 'approved' | 'rejected';
	vs_users: {
		id: string;
		rsn: string | null;
		discord_username: string;
		account_type: string | null;
		clan_allegiance: string | null;
	};
}

export interface PendingGroup {
	user_id: string;
	tile_id: string;
	user: {
		rsn: string | null;
		discord_username: string;
		account_type: string | null;
		clan_allegiance: string | null;
		clan_label: string | null;
	};
	tile: Pick<BingoTile, 'id' | 'name' | 'tier' | 'points' | 'row'> & {
		details_html: string | null;
	};
	submissions: Array<{ id: string; proof_urls: string[]; submitted_at: string }>;
}

function requireBingoSlug(slug: string): void {
	if (slug !== BINGO_EVENT_SLUG) throw error(404, 'Not found');
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
	requireBingoSlug(params.slug);

	const event = await fetchEvent(params.slug);
	if (!event) throw error(404, 'Event not found');

	const { data: pendingRaw, error: qErr } = await db()
		.from('vs_bingo_completions')
		.select(
			'id, user_id, tile_id, proof_urls, submitted_at, status, vs_users!user_id(id, rsn, discord_username, account_type, clan_allegiance)'
		)
		.eq('event_id', event.id)
		.eq('status', 'pending')
		.order('submitted_at', { ascending: true });

	if (qErr) throw error(500, qErr.message);

	const pending = (pendingRaw ?? []) as unknown as PendingRow[];

	// Group by (user_id, tile_id), keeping the earliest submitted_at as the group sort key.
	const groupsMap = new Map<string, PendingGroup>();

	for (const row of pending) {
		const tile = BINGO_TILE_BY_ID[row.tile_id];
		if (!tile) continue;

		const key = `${row.user_id}|${row.tile_id}`;
		let group = groupsMap.get(key);
		if (!group) {
			const detailsMd = getTileDetails(tile.id);
			group = {
				user_id: row.user_id,
				tile_id: row.tile_id,
				user: {
					rsn: row.vs_users.rsn,
					discord_username: row.vs_users.discord_username,
					account_type: row.vs_users.account_type,
					clan_allegiance: row.vs_users.clan_allegiance,
					clan_label: row.vs_users.clan_allegiance
						? CLAN_LABEL[row.vs_users.clan_allegiance as keyof typeof CLAN_LABEL] ?? null
						: null
				},
				tile: {
					id: tile.id,
					name: tile.name,
					tier: tile.tier,
					points: tile.points,
					row: tile.row,
					details_html: detailsMd ? renderMarkdown(detailsMd) : null
				},
				submissions: []
			};
			groupsMap.set(key, group);
		}
		group.submissions.push({
			id: row.id,
			proof_urls: row.proof_urls ?? [],
			submitted_at: row.submitted_at
		});
	}

	const groups = Array.from(groupsMap.values());

	// Also fetch quick stats so the admin sees overall progress.
	const { count: approvedCount } = await db()
		.from('vs_bingo_completions')
		.select('id', { count: 'exact', head: true })
		.eq('event_id', event.id)
		.eq('status', 'approved');

	const { count: rejectedCount } = await db()
		.from('vs_bingo_completions')
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
	userId,
	tileId,
	reviewerId,
	newStatus,
	note
}: {
	eventId: string;
	userId: string;
	tileId: string;
	reviewerId: string;
	newStatus: 'approved' | 'rejected';
	note: string | null;
}) {
	return db()
		.from('vs_bingo_completions')
		.update({
			status: newStatus,
			reviewed_at: new Date().toISOString(),
			reviewed_by: reviewerId,
			review_note: note
		})
		.eq('event_id', eventId)
		.eq('user_id', userId)
		.eq('tile_id', tileId)
		.eq('status', 'pending');
}

export const actions: Actions = {
	approve: async ({ params, locals, request }) => {
		if (!locals.user) throw redirect(303, '/');
		if (!isAdmin(locals.user)) return fail(403, { error: 'Not allowed' });
		requireBingoSlug(params.slug);

		const event = await fetchEvent(params.slug);
		if (!event) return fail(404, { error: 'Event not found' });

		const form = await request.formData();
		const userId = form.get('user_id')?.toString() ?? '';
		const tileId = form.get('tile_id')?.toString() ?? '';
		if (!userId || !tileId) return fail(400, { error: 'Missing user_id / tile_id' });

		const { error: upErr } = await updateGroupStatus({
			eventId: event.id,
			userId,
			tileId,
			reviewerId: locals.user.id,
			newStatus: 'approved',
			note: null
		});
		if (upErr) return fail(500, { error: upErr.message });

		return { ok: true, action: 'approve' as const, user_id: userId, tile_id: tileId };
	},

	reject: async ({ params, locals, request }) => {
		if (!locals.user) throw redirect(303, '/');
		if (!isAdmin(locals.user)) return fail(403, { error: 'Not allowed' });
		requireBingoSlug(params.slug);

		const event = await fetchEvent(params.slug);
		if (!event) return fail(404, { error: 'Event not found' });

		const form = await request.formData();
		const userId = form.get('user_id')?.toString() ?? '';
		const tileId = form.get('tile_id')?.toString() ?? '';
		const note = form.get('note')?.toString().trim() || null;
		if (!userId || !tileId) return fail(400, { error: 'Missing user_id / tile_id' });

		const { error: upErr } = await updateGroupStatus({
			eventId: event.id,
			userId,
			tileId,
			reviewerId: locals.user.id,
			newStatus: 'rejected',
			note
		});
		if (upErr) return fail(500, { error: upErr.message });

		return { ok: true, action: 'reject' as const, user_id: userId, tile_id: tileId };
	}
};
