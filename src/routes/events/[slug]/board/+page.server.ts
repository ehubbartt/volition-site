import { redirect, fail, error } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { isAdmin } from '$lib/server/auth';
import { isClanMember } from '$lib/server/clan';
import { renderMarkdown } from '$lib/markdown';
import { duoNodeRefs } from '$lib/board/config';
import { getBoardStatus, type BoardStatus } from '$lib/board/state';
import {
	DUO_WOLF_EVENT_SLUG,
	DUO_TILE_IDS,
	getDuoTileName,
	getDuoTileFaq
} from '$lib/server/duoWolfTiles';
import {
	BINGO_BUCKET,
	MAX_UPLOAD_BYTES,
	MAX_IMAGES_PER_SUBMISSION,
	ALLOWED_MIME
} from '$lib/bingo/config';
import type { Actions, PageServerLoad } from './$types';

type SubmissionStatus = 'pending' | 'approved' | 'rejected';

interface CompletionRow {
	id: string;
	team_id: string;
	user_id: string;
	tile_id: string;
	proof_urls: string[] | null;
	proof_paths: string[] | null;
	submitted_at: string;
	status: SubmissionStatus;
	vs_users: {
		rsn: string | null;
		discord_username: string;
		account_type: string | null;
	};
	reviewer: {
		rsn: string | null;
		discord_username: string;
	} | null;
	team: {
		id: string;
		name: string | null;
	} | null;
}

interface DuoCompletionDetail {
	id: string;
	user_id: string;
	rsn: string | null;
	discord_username: string;
	account_type: string | null;
	team_name: string | null;
	submitted_at: string;
	proof_urls: string[];
	reviewed_by_name: string | null;
	isMine: boolean;
}

interface DuoTeamSubmission {
	id: string;
	proof_urls: string[];
	submitted_at: string;
	status: SubmissionStatus;
	reviewed_by_name: string | null;
	submitted_by_name: string;
}

const EXT_BY_MIME: Record<string, string> = {
	'image/png': 'png',
	'image/jpeg': 'jpg',
	'image/webp': 'webp',
	'image/gif': 'gif'
};

// Convert single newlines in the (markdown-able) FAQ into hard breaks, leaving
// blank-line paragraph breaks intact. renderMarkdown runs with breaks:false.
function faqToHtml(faq: string | null): string | null {
	if (!faq) return null;
	return renderMarkdown(faq.replace(/(?<!\n)\n(?!\n)/g, '  \n'));
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

async function getMyTeamId(eventId: string, userId: string): Promise<string | null> {
	const { data } = await db()
		.from('vs_event_signups')
		.select('team_id')
		.eq('event_id', eventId)
		.eq('user_id', userId)
		.maybeSingle();
	return data?.team_id ?? null;
}

export const load: PageServerLoad = async ({ params, locals }) => {
	if (!locals.user) throw redirect(303, '/');
	if (!locals.user.rsn || !locals.user.clan_allegiance || !locals.user.account_type) {
		throw redirect(303, '/onboarding');
	}

	const event = await fetchEvent(params.slug);
	if (!event) throw error(404, 'Event not found');

	const admin = isAdmin(locals.user);
	const status: BoardStatus = getBoardStatus(event.status, admin);
	const isDuoWolf = event.slug === DUO_WOLF_EVENT_SLUG;
	const contentVisible = isDuoWolf && (admin || status === 'open');

	const empty = {
		event: { id: event.id, slug: event.slug, name: event.name, status: event.status },
		status,
		isClanMember: false,
		myTeamId: null as string | null,
		hasTeam: false,
		content: {} as Record<string, { name: string; faq_html: string | null }>,
		completionsByTile: {} as Record<string, DuoCompletionDetail[]>,
		completionCountByTile: {} as Record<string, number>,
		teamSubmissionsByTile: {} as Record<string, DuoTeamSubmission[]>,
		teamDoneByTile: {} as Record<string, boolean>
	};

	if (!contentVisible) return empty;

	const memberOfClan = await isClanMember(locals.user.discord_id, locals.user.rsn);
	const myTeamId = await getMyTeamId(event.id, locals.user.id);

	// Build the (admin/clan-visible) tile content keyed by board node id.
	const content: Record<string, { name: string; faq_html: string | null }> = {};
	for (const ref of duoNodeRefs()) {
		content[ref.id] = {
			name: getDuoTileName(ref.id) ?? ref.id,
			faq_html: faqToHtml(getDuoTileFaq(ref.id))
		};
	}

	const { data: completionsRaw, error: cErr } = await db()
		.from('vs_duo_completions')
		.select(
			'id, team_id, user_id, tile_id, proof_urls, proof_paths, submitted_at, status, vs_users!user_id(rsn, discord_username, account_type), reviewer:vs_users!reviewed_by(rsn, discord_username), team:vs_teams!team_id(id, name)'
		)
		.eq('event_id', event.id)
		.order('submitted_at', { ascending: true });
	// Degrade gracefully if the table isn't there yet (migration 0012 applied by
	// hand): admins can still preview tile content; submissions just show empty.
	if (cErr) console.warn('[duo board] could not load completions:', cErr.message);

	const completions = (completionsRaw ?? []) as unknown as CompletionRow[];

	const completionsByTile: Record<string, DuoCompletionDetail[]> = {};
	const completionCountByTile: Record<string, number> = {};
	const teamSubmissionsByTile: Record<string, DuoTeamSubmission[]> = {};
	const teamDoneByTile: Record<string, boolean> = {};

	for (const c of completions) {
		if (!DUO_TILE_IDS.has(c.tile_id)) continue;
		const proofUrls = c.proof_urls ?? [];
		const reviewerName = c.reviewer ? (c.reviewer.rsn ?? c.reviewer.discord_username) : null;
		const submitterName = c.vs_users.rsn ?? c.vs_users.discord_username;
		const mine = myTeamId != null && c.team_id === myTeamId;

		if (c.status === 'approved') {
			const arr = completionsByTile[c.tile_id] ?? [];
			arr.push({
				id: c.id,
				user_id: c.user_id,
				rsn: c.vs_users.rsn,
				discord_username: c.vs_users.discord_username,
				account_type: c.vs_users.account_type,
				team_name: c.team?.name ?? null,
				submitted_at: c.submitted_at,
				proof_urls: proofUrls,
				reviewed_by_name: reviewerName,
				isMine: mine
			});
			completionsByTile[c.tile_id] = arr;
			completionCountByTile[c.tile_id] = (completionCountByTile[c.tile_id] ?? 0) + 1;
			if (mine) teamDoneByTile[c.tile_id] = true;
		}

		// The viewer's own team always sees its submissions (pending/rejected too).
		if (mine) {
			const t = teamSubmissionsByTile[c.tile_id] ?? [];
			t.push({
				id: c.id,
				proof_urls: proofUrls,
				submitted_at: c.submitted_at,
				status: c.status,
				reviewed_by_name: reviewerName,
				submitted_by_name: submitterName
			});
			teamSubmissionsByTile[c.tile_id] = t;
		}
	}

	// Per-team proof detail is admin-only (like bingo); everyone still gets counts.
	const communityForClient: Record<string, DuoCompletionDetail[]> = admin ? completionsByTile : {};

	return {
		event: { id: event.id, slug: event.slug, name: event.name, status: event.status },
		status,
		isClanMember: memberOfClan,
		myTeamId,
		hasTeam: myTeamId != null,
		content,
		completionsByTile: communityForClient,
		completionCountByTile,
		teamSubmissionsByTile,
		teamDoneByTile
	};
};

function requireDuoWolf(slug: string): void {
	if (slug !== DUO_WOLF_EVENT_SLUG) throw error(404, 'Not found');
}

async function uploadProof(
	eventId: string,
	userId: string,
	tileId: string,
	file: File
): Promise<{ path: string; url: string } | { error: string }> {
	if (file.size === 0) return { error: 'File is empty' };
	if (file.size > MAX_UPLOAD_BYTES) {
		const mb = Math.round(MAX_UPLOAD_BYTES / 1_000_000);
		return { error: `File too large (max ${mb} MB)` };
	}
	if (!(ALLOWED_MIME as readonly string[]).includes(file.type)) {
		return { error: 'Unsupported image type (use PNG, JPEG, WEBP, or GIF)' };
	}
	const ext = EXT_BY_MIME[file.type];
	if (!ext) return { error: 'Unsupported image type' };

	const path = `${eventId}/${userId}/${tileId}-${Date.now()}.${ext}`;
	const storage = db().storage.from(BINGO_BUCKET);
	const { error: upErr } = await storage.upload(path, file, {
		contentType: file.type,
		upsert: false
	});
	if (upErr) return { error: upErr.message };

	const { data: pub } = storage.getPublicUrl(path);
	return { path, url: pub.publicUrl };
}

export const actions: Actions = {
	submit: async ({ params, locals, request }) => {
		if (!locals.user) throw redirect(303, '/');
		requireDuoWolf(params.slug);

		if (!(await isClanMember(locals.user.discord_id, locals.user.rsn))) {
			return fail(403, { error: 'Only Volition clan members can submit tiles for this event.' });
		}

		const event = await fetchEvent(params.slug);
		if (!event) return fail(404, { error: 'Event not found' });
		const admin = isAdmin(locals.user);
		const isActive = event.status === 'open' || (event.status === 'preview' && admin);
		if (!isActive) return fail(400, { error: 'Submissions are closed' });

		const teamId = await getMyTeamId(event.id, locals.user.id);
		if (!teamId) {
			return fail(400, { error: 'Join the event and pair up with a teammate before submitting.' });
		}

		const form = await request.formData();
		const tileId = form.get('tile_id')?.toString() ?? '';
		const files = form.getAll('proof').filter((f): f is File => f instanceof File && f.size > 0);

		if (!DUO_TILE_IDS.has(tileId)) return fail(400, { error: 'Unknown tile' });
		if (files.length === 0) return fail(400, { error: 'Add at least one proof image' });
		if (files.length > MAX_IMAGES_PER_SUBMISSION) {
			return fail(400, { error: `Max ${MAX_IMAGES_PER_SUBMISSION} images per submission` });
		}

		const urls: string[] = [];
		const paths: string[] = [];
		for (const file of files) {
			const result = await uploadProof(event.id, locals.user.id, tileId, file);
			if ('error' in result) {
				if (paths.length) await db().storage.from(BINGO_BUCKET).remove(paths);
				return fail(400, { error: result.error });
			}
			urls.push(result.url);
			paths.push(result.path);
		}

		const { error: insErr } = await db().from('vs_duo_completions').insert({
			event_id: event.id,
			team_id: teamId,
			user_id: locals.user.id,
			tile_id: tileId,
			proof_urls: urls,
			proof_paths: paths,
			proof_url: urls[0],
			proof_path: paths[0]
		});
		if (insErr) {
			await db().storage.from(BINGO_BUCKET).remove(paths);
			return fail(500, { error: insErr.message });
		}

		return { ok: true, action: 'submit' as const, tile_id: tileId };
	},

	remove: async ({ params, locals, request }) => {
		if (!locals.user) throw redirect(303, '/');
		requireDuoWolf(params.slug);

		if (!(await isClanMember(locals.user.discord_id, locals.user.rsn))) {
			return fail(403, { error: 'Only Volition clan members can manage submissions.' });
		}

		const event = await fetchEvent(params.slug);
		if (!event) return fail(404, { error: 'Event not found' });
		const admin = isAdmin(locals.user);
		const isActive = event.status === 'open' || (event.status === 'preview' && admin);
		if (!isActive) return fail(400, { error: 'You can only remove submissions while the event is open' });

		const teamId = await getMyTeamId(event.id, locals.user.id);
		if (!teamId) return fail(400, { error: "You're not on a team for this event" });

		const form = await request.formData();
		const submissionId = form.get('submission_id')?.toString() ?? '';
		if (!submissionId) return fail(400, { error: 'Missing submission_id' });

		// Any teammate may remove their team's submission.
		const { data: existing } = await db()
			.from('vs_duo_completions')
			.select('id, proof_paths')
			.eq('id', submissionId)
			.eq('event_id', event.id)
			.eq('team_id', teamId)
			.maybeSingle();
		if (!existing) return fail(404, { error: 'Submission not found' });

		const { error: delErr } = await db()
			.from('vs_duo_completions')
			.delete()
			.eq('id', existing.id);
		if (delErr) return fail(500, { error: delErr.message });

		const paths = (existing.proof_paths ?? []) as string[];
		if (paths.length) {
			await db().storage.from(BINGO_BUCKET).remove(paths);
		}

		return { ok: true, action: 'remove' as const, submission_id: submissionId };
	},

	adminReject: async ({ params, locals, request }) => {
		if (!locals.user) throw redirect(303, '/');
		if (!isAdmin(locals.user)) return fail(403, { error: 'Not allowed' });
		requireDuoWolf(params.slug);

		const event = await fetchEvent(params.slug);
		if (!event) return fail(404, { error: 'Event not found' });

		const form = await request.formData();
		const submissionId = form.get('submission_id')?.toString() ?? '';
		const note = form.get('note')?.toString().trim() || null;
		if (!submissionId) return fail(400, { error: 'Missing submission_id' });

		const { error: upErr } = await db()
			.from('vs_duo_completions')
			.update({
				status: 'rejected',
				reviewed_at: new Date().toISOString(),
				reviewed_by: locals.user.id,
				review_note: note
			})
			.eq('id', submissionId)
			.eq('event_id', event.id);
		if (upErr) return fail(500, { error: upErr.message });

		return { ok: true, action: 'adminReject' as const, submission_id: submissionId };
	}
};
