import { redirect, error, fail } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { isAdmin } from '$lib/server/auth';
import { BINGO_EVENT_SLUG } from '$lib/bingo/config';
import { BINGO_TILE_BY_ID } from '$lib/server/bingoTiles';
import { CLAN_LABEL } from '$lib/clans';
import type { BingoTier } from '$lib/bingo/tiles';
import type { Actions, PageServerLoad } from './$types';

type SubmissionStatus = 'pending' | 'approved' | 'rejected';

interface SubRow {
	id: string;
	tile_id: string;
	proof_urls: string[] | null;
	submitted_at: string;
	status: SubmissionStatus;
	reviewer: { rsn: string | null; discord_username: string } | null;
}

export const load: PageServerLoad = async ({ params, locals }) => {
	if (!locals.user) throw redirect(303, '/');
	if (!isAdmin(locals.user)) throw error(403, 'Not allowed');
	if (params.slug !== BINGO_EVENT_SLUG) throw error(404, 'Not found');

	const { data: event, error: evErr } = await db()
		.from('vs_events')
		.select('id, slug, name')
		.eq('slug', params.slug)
		.maybeSingle();
	if (evErr) throw error(500, evErr.message);
	if (!event) throw error(404, 'Event not found');

	const { data: target, error: uErr } = await db()
		.from('vs_users')
		.select('id, rsn, discord_username, account_type, clan_allegiance')
		.eq('id', params.userId)
		.maybeSingle();
	if (uErr) throw error(500, uErr.message);
	if (!target) throw error(404, 'User not found');

	const { data: subsRaw, error: sErr } = await db()
		.from('vs_bingo_completions')
		.select(
			'id, tile_id, proof_urls, submitted_at, status, reviewer:vs_users!reviewed_by(rsn, discord_username)'
		)
		.eq('event_id', event.id)
		.eq('user_id', params.userId)
		.order('submitted_at', { ascending: true });
	if (sErr) throw error(500, sErr.message);

	const subs = (subsRaw ?? []) as SubRow[];

	// Group submissions by tile, attaching tile metadata.
	const groupsMap = new Map<
		string,
		{
			tile_id: string;
			tile_name: string;
			tier: BingoTier;
			points: number;
			row: number;
			status: SubmissionStatus; // best status for the tile
			submissions: Array<{
				id: string;
				proof_urls: string[];
				submitted_at: string;
				status: SubmissionStatus;
				reviewed_by_name: string | null;
			}>;
		}
	>();

	let totalPoints = 0;
	const scoredTiles = new Set<string>();

	for (const s of subs) {
		const tile = BINGO_TILE_BY_ID[s.tile_id];
		if (!tile) continue;

		let g = groupsMap.get(s.tile_id);
		if (!g) {
			g = {
				tile_id: s.tile_id,
				tile_name: tile.name,
				tier: tile.tier,
				points: tile.points,
				row: tile.row,
				status: 'rejected',
				submissions: []
			};
			groupsMap.set(s.tile_id, g);
		}
		g.submissions.push({
			id: s.id,
			proof_urls: s.proof_urls ?? [],
			submitted_at: s.submitted_at,
			status: s.status,
			reviewed_by_name: s.reviewer ? (s.reviewer.rsn ?? s.reviewer.discord_username) : null
		});

		if (s.status === 'approved' && !scoredTiles.has(s.tile_id)) {
			scoredTiles.add(s.tile_id);
			totalPoints += tile.points;
		}
	}

	// Best status per tile: approved > pending > rejected.
	for (const g of groupsMap.values()) {
		if (g.submissions.some((x) => x.status === 'approved')) g.status = 'approved';
		else if (g.submissions.some((x) => x.status === 'pending')) g.status = 'pending';
		else g.status = 'rejected';
	}

	const groups = Array.from(groupsMap.values()).sort((a, b) => a.row - b.row);

	return {
		event: { slug: event.slug, name: event.name },
		target: {
			id: target.id,
			rsn: target.rsn,
			discord_username: target.discord_username,
			account_type: target.account_type,
			clan_label: target.clan_allegiance
				? CLAN_LABEL[target.clan_allegiance as keyof typeof CLAN_LABEL] ?? null
				: null
		},
		groups,
		totalPoints,
		totalSubmissions: subs.length,
		approvedTiles: scoredTiles.size
	};
};

async function setSubmissionStatus(
	params: { slug: string; userId: string },
	locals: App.Locals,
	request: Request,
	newStatus: 'approved' | 'rejected'
) {
	if (!locals.user) throw redirect(303, '/');
	if (!isAdmin(locals.user)) return fail(403, { error: 'Not allowed' });
	if (params.slug !== BINGO_EVENT_SLUG) throw error(404, 'Not found');

	const { data: event } = await db()
		.from('vs_events')
		.select('id')
		.eq('slug', params.slug)
		.maybeSingle();
	if (!event) return fail(404, { error: 'Event not found' });

	const form = await request.formData();
	const submissionId = form.get('submission_id')?.toString() ?? '';
	if (!submissionId) return fail(400, { error: 'Missing submission_id' });

	const { error: upErr } = await db()
		.from('vs_bingo_completions')
		.update({
			status: newStatus,
			reviewed_at: new Date().toISOString(),
			reviewed_by: locals.user.id
		})
		.eq('id', submissionId)
		.eq('event_id', event.id)
		.eq('user_id', params.userId);
	if (upErr) return fail(500, { error: upErr.message });

	return { ok: true, submission_id: submissionId, status: newStatus };
}

export const actions: Actions = {
	approve: ({ params, locals, request }) =>
		setSubmissionStatus(params, locals, request, 'approved'),
	reject: ({ params, locals, request }) =>
		setSubmissionStatus(params, locals, request, 'rejected')
};
