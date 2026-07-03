import { redirect, fail, error } from '@sveltejs/kit';
import { db, fetchAllFiltered } from '$lib/server/db';
import {
	BINGO_BUCKET,
	MAX_UPLOAD_BYTES,
	MAX_IMAGES_PER_SUBMISSION,
	ALLOWED_MIME,
	COLUMN_PALETTE
} from '$lib/bingo/config';
import type { BingoTile } from '$lib/bingo/tiles';
import { getBingoState, getTileStatus } from '$lib/bingo/state';
import { loadEventBoard, type EventBoard } from '$lib/server/eventStructure';
import { maybeProcessDinkDrops } from '$lib/server/dinkDrops';
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
	reviewer: {
		rsn: string | null;
		discord_username: string;
	} | null;
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

async function fetchBingoEvent(slug: string) {
	const { data, error: qErr } = await db()
		.from('vs_events')
		.select('id, slug, name, kind, description, status, signup_opens_at, signup_closes_at, starts_at, ends_at, structure')
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
	// Poll-on-read backstop: credit any pending Dink auto-tracked drops (throttled,
	// best-effort) so the board is current even if the cron processor lags.
	maybeProcessDinkDrops();

	// The event row and the caller's clan-membership check are independent.
	const [event, memberOfClan] = await Promise.all([
		fetchBingoEvent(params.slug),
		isClanMember(locals.user.discord_id, locals.user.rsn)
	]);
	if (!event) throw error(404, 'Not found');

	const admin = isAdmin(locals.user);

	if (event.status === 'preview' && !admin) {
		throw error(404, 'Not found');
	}

	// Board + (when the full view will render) the whole completions history fetch
	// together — both need only the event row. The redacted draft/preview path never
	// pays for completions, same as before.
	const redacted = event.status === 'draft' || (event.status === 'preview' && !admin);
	const [board, completionsRes] = await Promise.all([
		loadEventBoard(event) as Promise<EventBoard>,
		redacted
			? Promise.resolve(null)
			: // Paginate: once an event passes 1000 tile submissions an un-paged read drops
				// the newest rows (oldest-first order) → an incomplete leaderboard.
				fetchAllFiltered((f, t) =>
					db()
						.from('vs_bingo_completions')
						.select(
							'id, user_id, tile_id, proof_urls, proof_paths, submitted_at, status, vs_users!user_id(id, rsn, discord_username, clan_allegiance, account_type), reviewer:vs_users!reviewed_by(rsn, discord_username)'
						)
						.eq('event_id', event.id)
						.order('submitted_at', { ascending: true })
						.range(f, t)
				)
	]);
	if (board.tiles.length === 0) throw error(404, 'Not found');
	const tileById = new Map(board.tiles.map((t) => [t.id, t]));

	// Derive the column model the board renders from (data-driven, any count/names).
	const BONUS_COLOR = '#ff981f';
	const mainTiers = board.structure.tiers.filter((t) => t.key !== 'bonus');
	const columns = mainTiers.map((t, i) => ({
		key: t.key,
		label: t.label,
		points: t.points,
		color: t.color ?? COLUMN_PALETTE[i % COLUMN_PALETTE.length]
	}));
	const bonusTier = board.structure.tiers.find((t) => t.key === 'bonus');
	const bonus = {
		label: bonusTier?.label || 'Bonus',
		points: bonusTier?.points ?? 5,
		color: bonusTier?.color ?? BONUS_COLOR
	};
	const colorByKey = new Map(columns.map((c) => [c.key, c.color]));
	const tileColor = (t: BingoTile): string =>
		t.tier === 'bonus' ? bonus.color : colorByKey.get(t.tier) ?? BONUS_COLOR;

	if (redacted) {
		const redactedTiles: BingoTile[] = board.tiles.map((t) => ({
			...t,
			name: 'nice try',
			details_html: null,
			color: tileColor(t)
		}));
		return {
			event: {
				name: event.name,
				description_html: renderMarkdown(event.description),
				status: event.status
			},
			running: false as const,
			archived: false as const,
			state: null,
			tiles: redactedTiles,
			columns,
			bonus,
			bonusEnabled: board.structure.bonusEnabled,
			isClanMember: memberOfClan,
			completionsByTile: {} as Record<string, never>,
			completionCountByTile: {} as Record<string, never>,
			mySubmissions: {} as Record<string, never>,
			leaderboard: [] as never[]
		};
	}

	// A closed event becomes a read-only archive: the whole board is revealed
	// (force the state to 'ended' → every tile is 'past-locked', so names/details
	// are shown but no submissions are accepted), with the final leaderboard and
	// each player's own submissions kept visible to look back on.
	const archived = event.status === 'closed';
	const baseState = getBingoState((event.starts_at ?? event.signup_opens_at), new Date(), board.structure);
	const state = archived ? { ...baseState, status: 'ended' as const } : baseState;

	// Completions were prefetched above alongside the board.
	const { data: completionsRaw, error: cErr } = completionsRes ?? { data: [], error: null };

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
			reviewed_by_name: string | null;
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
			reviewed_by_name: string | null;
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
		const tile = tileById.get(c.tile_id);
		if (!tile) continue;

		const proofUrls = c.proof_urls ?? [];
		const reviewerName = c.reviewer ? (c.reviewer.rsn ?? c.reviewer.discord_username) : null;

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
				reviewed_by_name: reviewerName,
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
				status: c.status,
				reviewed_by_name: reviewerName
			});
			mySubmissions[c.tile_id] = mine;
		}
	}

	const leaderboard = Array.from(userPoints.values()).sort((a, b) => {
		if (b.points !== a.points) return b.points - a.points;
		return b.count - a.count;
	});

	const tiles: BingoTile[] = board.tiles.map((t) => {
		const color = tileColor(t);
		if (getTileStatus(t, state) === 'blurred') {
			return { ...t, name: 'nice try', details_html: null, color };
		}
		const md = board.getDetails(t.id);
		return { ...t, details_html: md ? renderMarkdown(md) : null, color };
	});

	// Detailed community list (proofs + names) is admin-only while the event runs.
	// Once it's archived, the whole board is opened up so everyone can look back.
	// Regular users on a running event still get the count so the modal can show "N completed".
	const communityForClient = admin || archived ? completionsByTile : {};

	return {
		event: {
			id: event.id,
			slug: event.slug,
			name: event.name,
			description_html: renderMarkdown(event.description),
			status: event.status,
			start_at: (event.starts_at ?? event.signup_opens_at)
		},
		running: !archived,
		archived,
		state,
		tiles,
		columns,
		bonus,
		bonusEnabled: board.structure.bonusEnabled,
		isClanMember: memberOfClan,
		completionsByTile: communityForClient,
		completionCountByTile,
		mySubmissions,
		leaderboard
	};
};

async function tileIsSubmittable(
	event: { id: string; slug: string; structure?: unknown; starts_at: string | null; signup_opens_at: string | null },
	tileId: string
): Promise<boolean> {
	const board = await loadEventBoard(event);
	const tile = board.tiles.find((t) => t.id === tileId);
	if (!tile) return false;
	const state = getBingoState(event.starts_at ?? event.signup_opens_at, new Date(), board.structure);
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

		const board = await loadEventBoard(event);
		if (!board.tiles.some((t) => t.id === tileId)) return fail(400, { error: 'Unknown tile' });
		if (files.length === 0) return fail(400, { error: 'Add at least one proof image' });
		if (files.length > MAX_IMAGES_PER_SUBMISSION) {
			return fail(400, { error: `Max ${MAX_IMAGES_PER_SUBMISSION} images per submission` });
		}
		if (!(await tileIsSubmittable(event, tileId))) {
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

		if (!(await isClanMember(locals.user.discord_id, locals.user.rsn))) {
			return fail(403, { error: 'Only Volition clan members can manage submissions.' });
		}

		const event = await fetchBingoEvent(params.slug);
		if (!event) return fail(404, { error: 'Event not found' });
		if (event.status === 'closed') {
			return fail(400, { error: 'This event has ended — submissions are locked.' });
		}

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

		if (!(await tileIsSubmittable(event, existing.tile_id))) {
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
