import { redirect, fail, error } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import {
	BINGO_BUCKET,
	BINGO_EVENT_SLUG,
	MAX_UPLOAD_BYTES,
	MAX_IMAGES_PER_SUBMISSION,
	ALLOWED_MIME
} from '$lib/bingo/config';
import { BINGO_TILE_BY_ID, BINGO_TILES, getTileDetails } from '$lib/server/bingoTiles';
import type { BingoTile } from '$lib/bingo/tiles';
import { getBingoState, getTileStatus } from '$lib/bingo/state';
import { renderMarkdown } from '$lib/markdown';
import { isAdmin } from '$lib/server/auth';
import { isClanMember } from '$lib/server/clan';
import type { Actions, PageServerLoad } from './$types';

type SubmissionStatus = 'pending' | 'approved' | 'rejected';

interface CompletionRow {
	id: string;
	user_id: string;
	tile_id: string;
	proof_urls: string[] | null;
	proof_paths: string[] | null;
	submitted_at: string;
	status: SubmissionStatus;
	vs_users: {
		id: string;
		rsn: string | null;
		discord_username: string;
		clan_allegiance: string | null;
		account_type: string | null;
	};
}

const EXT_BY_MIME: Record<string, string> = {
	'image/png': 'png',
	'image/jpeg': 'jpg',
	'image/webp': 'webp',
	'image/gif': 'gif'
};

function extForMime(mime: string): string | null {
	return EXT_BY_MIME[mime] ?? null;
}

function requireBingoSlug(slug: string): void {
	if (slug !== BINGO_EVENT_SLUG) throw error(404, 'Not found');
}

async function fetchBingoEvent(slug: string) {
	const { data, error: qErr } = await db()
		.from('vs_events')
		.select('id, slug, name, description, status, signup_opens_at, signup_closes_at, starts_at, ends_at')
		.eq('slug', slug)
		.maybeSingle();
	if (qErr) throw new Error(qErr.message);
	return data;
}

export const load: PageServerLoad = async ({ params, locals }) => {
	if (!locals.user) throw redirect(303, '/');
	if (!locals.user.rsn || !locals.user.clan_allegiance || !locals.user.account_type) {
		throw redirect(303, '/onboarding');
	}
	requireBingoSlug(params.slug);

	const event = await fetchBingoEvent(params.slug);

	const memberOfClan = await isClanMember(locals.user.discord_id, locals.user.rsn);
	const admin = isAdmin(locals.user);

	if (event && event.status === 'preview' && !admin) {
		throw error(404, 'Not found');
	}

	if (
		!event ||
		event.status === 'draft' ||
		event.status === 'closed' ||
		(event.status === 'preview' && !admin)
	) {
		const redactedTiles: BingoTile[] = BINGO_TILES.map((t) => ({
			...t,
			name: 'nice try',
			details_html: null
		}));
		return {
			event: event
				? {
						name: event.name,
						description_html: renderMarkdown(event.description),
						status: event.status
					}
				: null,
			running: false as const,
			state: null,
			tiles: redactedTiles,
			isClanMember: memberOfClan,
			completionsByTile: {} as Record<string, never>,
			completionCountByTile: {} as Record<string, never>,
			mySubmissions: {} as Record<string, never>,
			leaderboard: [] as never[]
		};
	}

	const state = getBingoState((event.starts_at ?? event.signup_opens_at), new Date());

	const { data: completionsRaw, error: cErr } = await db()
		.from('vs_bingo_completions')
		.select(
			'id, user_id, tile_id, proof_urls, proof_paths, submitted_at, status, vs_users!user_id(id, rsn, discord_username, clan_allegiance, account_type)'
		)
		.eq('event_id', event.id)
		.order('submitted_at', { ascending: true });

	if (cErr) throw new Error(cErr.message);

	const completions = (completionsRaw ?? []) as unknown as CompletionRow[];

	const completionsByTile: Record<
		string,
		Array<{
			id: string;
			user_id: string;
			rsn: string | null;
			discord_username: string;
			account_type: string | null;
			submitted_at: string;
			proof_urls: string[];
			isMe: boolean;
		}>
	> = {};

	const completionCountByTile: Record<string, number> = {};

	const mySubmissions: Record<
		string,
		Array<{
			id: string;
			proof_urls: string[];
			submitted_at: string;
			status: SubmissionStatus;
		}>
	> = {};

	const scoredPairs = new Set<string>();
	const userPoints = new Map<
		string,
		{
			user_id: string;
			rsn: string | null;
			discord_username: string;
			account_type: string | null;
			points: number;
			count: number;
		}
	>();

	for (const c of completions) {
		const tile = BINGO_TILE_BY_ID[c.tile_id];
		if (!tile) continue;

		const proofUrls = c.proof_urls ?? [];

		// Community list + leaderboard only count approved submissions.
		if (c.status === 'approved') {
			const arr = completionsByTile[c.tile_id] ?? [];
			arr.push({
				id: c.id,
				user_id: c.user_id,
				rsn: c.vs_users.rsn,
				discord_username: c.vs_users.discord_username,
				account_type: c.vs_users.account_type,
				submitted_at: c.submitted_at,
				proof_urls: proofUrls,
				isMe: c.user_id === locals.user!.id
			});
			completionsByTile[c.tile_id] = arr;

			completionCountByTile[c.tile_id] = (completionCountByTile[c.tile_id] ?? 0) + 1;

			const pairKey = `${c.user_id}|${c.tile_id}`;
			const existing = userPoints.get(c.user_id) ?? {
				user_id: c.user_id,
				rsn: c.vs_users.rsn,
				discord_username: c.vs_users.discord_username,
				account_type: c.vs_users.account_type,
				points: 0,
				count: 0
			};
			if (!scoredPairs.has(pairKey)) {
				scoredPairs.add(pairKey);
				existing.points += tile.points;
				existing.count += 1;
			}
			userPoints.set(c.user_id, existing);
		}

		// Submitter always sees their own submissions, including pending + rejected ones.
		if (c.user_id === locals.user!.id) {
			const mine = mySubmissions[c.tile_id] ?? [];
			mine.push({
				id: c.id,
				proof_urls: proofUrls,
				submitted_at: c.submitted_at,
				status: c.status
			});
			mySubmissions[c.tile_id] = mine;
		}
	}

	const leaderboard = Array.from(userPoints.values()).sort((a, b) => {
		if (b.points !== a.points) return b.points - a.points;
		return b.count - a.count;
	});

	const tiles: BingoTile[] = BINGO_TILES.map((t) => {
		if (getTileStatus(t, state) === 'blurred') {
			return { ...t, name: 'nice try', details_html: null };
		}
		const md = getTileDetails(t.id);
		return { ...t, details_html: md ? renderMarkdown(md) : null };
	});

	// Detailed community list (proofs + names) is admin-only.
	// Regular users still get the count so the modal can show "N completed".
	const communityForClient = admin ? completionsByTile : {};

	return {
		event: {
			id: event.id,
			slug: event.slug,
			name: event.name,
			description_html: renderMarkdown(event.description),
			status: event.status,
			start_at: (event.starts_at ?? event.signup_opens_at)
		},
		running: true as const,
		state,
		tiles,
		isClanMember: memberOfClan,
		completionsByTile: communityForClient,
		completionCountByTile,
		mySubmissions,
		leaderboard
	};
};

function tileIsSubmittable(tileId: string, eventStartIso: string | null): boolean {
	const tile = BINGO_TILE_BY_ID[tileId];
	if (!tile) return false;
	const state = getBingoState(eventStartIso, new Date());
	return getTileStatus(tile, state) === 'open';
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
	const ext = extForMime(file.type);
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
		requireBingoSlug(params.slug);

		if (!(await isClanMember(locals.user.discord_id, locals.user.rsn))) {
			return fail(403, { error: 'Only Volition clan members can submit tiles for this event.' });
		}

		const event = await fetchBingoEvent(params.slug);
		if (!event) return fail(404, { error: 'Event not found' });
		const admin = isAdmin(locals.user);
		const isActive = event.status === 'open' || (event.status === 'preview' && admin);
		if (!isActive) return fail(400, { error: 'Submissions are closed' });

		const form = await request.formData();
		const tileId = form.get('tile_id')?.toString() ?? '';
		const files = form.getAll('proof').filter((f): f is File => f instanceof File && f.size > 0);

		if (!BINGO_TILE_BY_ID[tileId]) return fail(400, { error: 'Unknown tile' });
		if (files.length === 0) return fail(400, { error: 'Add at least one proof image' });
		if (files.length > MAX_IMAGES_PER_SUBMISSION) {
			return fail(400, { error: `Max ${MAX_IMAGES_PER_SUBMISSION} images per submission` });
		}
		if (!tileIsSubmittable(tileId, (event.starts_at ?? event.signup_opens_at))) {
			return fail(400, { error: 'That tile is not open for submissions' });
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

		const { error: insErr } = await db().from('vs_bingo_completions').insert({
			event_id: event.id,
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
		requireBingoSlug(params.slug);

		if (!(await isClanMember(locals.user.discord_id, locals.user.rsn))) {
			return fail(403, { error: 'Only Volition clan members can manage submissions.' });
		}

		const event = await fetchBingoEvent(params.slug);
		if (!event) return fail(404, { error: 'Event not found' });

		const form = await request.formData();
		const submissionId = form.get('submission_id')?.toString() ?? '';
		if (!submissionId) return fail(400, { error: 'Missing submission_id' });

		const { data: existing } = await db()
			.from('vs_bingo_completions')
			.select('id, tile_id, proof_paths')
			.eq('id', submissionId)
			.eq('event_id', event.id)
			.eq('user_id', locals.user.id)
			.maybeSingle();
		if (!existing) return fail(404, { error: 'Submission not found' });

		if (!tileIsSubmittable(existing.tile_id, (event.starts_at ?? event.signup_opens_at))) {
			return fail(400, { error: 'You can only remove submissions while the tile is open' });
		}

		const { error: delErr } = await db()
			.from('vs_bingo_completions')
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
		requireBingoSlug(params.slug);

		const event = await fetchBingoEvent(params.slug);
		if (!event) return fail(404, { error: 'Event not found' });

		const form = await request.formData();
		const submissionId = form.get('submission_id')?.toString() ?? '';
		const note = form.get('note')?.toString().trim() || null;
		if (!submissionId) return fail(400, { error: 'Missing submission_id' });

		const { error: upErr } = await db()
			.from('vs_bingo_completions')
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

export const _allTiles = BINGO_TILES;
