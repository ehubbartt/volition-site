import { redirect, fail, error } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import {
	BINGO_BUCKET,
	BINGO_EVENT_SLUG,
	MAX_UPLOAD_BYTES,
	ALLOWED_MIME
} from '$lib/bingo/config';
import { BINGO_TILE_BY_ID, BINGO_TILES } from '$lib/server/bingoTiles';
import type { BingoTile } from '$lib/bingo/tiles';
import { getBingoState, getTileStatus } from '$lib/bingo/state';
import { renderMarkdown } from '$lib/markdown';
import type { Actions, PageServerLoad } from './$types';

interface CompletionRow {
	id: string;
	user_id: string;
	tile_id: string;
	proof_url: string;
	proof_path: string;
	submitted_at: string;
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

	if (!event || event.status === 'draft' || event.status === 'closed') {
		const redactedTiles: BingoTile[] = BINGO_TILES.map((t) => ({ ...t, name: 'nice try' }));
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
			completionsByTile: {} as Record<string, never>,
			mySubmissions: {} as Record<string, never>,
			leaderboard: [] as never[]
		};
	}

	const state = getBingoState((event.starts_at ?? event.signup_opens_at), new Date());

	const { data: completionsRaw, error: cErr } = await db()
		.from('vs_bingo_completions')
		.select(
			'id, user_id, tile_id, proof_url, proof_path, submitted_at, vs_users(id, rsn, discord_username, clan_allegiance, account_type)'
		)
		.eq('event_id', event.id)
		.order('submitted_at', { ascending: true });

	if (cErr) throw new Error(cErr.message);

	const completions = (completionsRaw ?? []) as unknown as CompletionRow[];

	const completionsByTile: Record<
		string,
		Array<{
			user_id: string;
			rsn: string | null;
			discord_username: string;
			account_type: string | null;
			submitted_at: string;
			proof_url: string;
			isMe: boolean;
		}>
	> = {};

	const mySubmissions: Record<
		string,
		{ proof_url: string; proof_path: string; submitted_at: string }
	> = {};

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

		const arr = completionsByTile[c.tile_id] ?? [];
		arr.push({
			user_id: c.user_id,
			rsn: c.vs_users.rsn,
			discord_username: c.vs_users.discord_username,
			account_type: c.vs_users.account_type,
			submitted_at: c.submitted_at,
			proof_url: c.proof_url,
			isMe: c.user_id === locals.user!.id
		});
		completionsByTile[c.tile_id] = arr;

		if (c.user_id === locals.user!.id) {
			mySubmissions[c.tile_id] = {
				proof_url: c.proof_url,
				proof_path: c.proof_path,
				submitted_at: c.submitted_at
			};
		}

		const existing = userPoints.get(c.user_id) ?? {
			user_id: c.user_id,
			rsn: c.vs_users.rsn,
			discord_username: c.vs_users.discord_username,
			account_type: c.vs_users.account_type,
			points: 0,
			count: 0
		};
		existing.points += tile.points;
		existing.count += 1;
		userPoints.set(c.user_id, existing);
	}

	const leaderboard = Array.from(userPoints.values()).sort((a, b) => {
		if (b.points !== a.points) return b.points - a.points;
		return b.count - a.count;
	});

	const tiles: BingoTile[] = BINGO_TILES.map((t) => {
		if (getTileStatus(t, state) === 'blurred') {
			return { ...t, name: 'nice try' };
		}
		return t;
	});

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
		completionsByTile,
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

async function removeStorageObject(path: string): Promise<void> {
	await db().storage.from(BINGO_BUCKET).remove([path]);
}

export const actions: Actions = {
	submit: async ({ params, locals, request }) => {
		if (!locals.user) throw redirect(303, '/');
		requireBingoSlug(params.slug);

		const event = await fetchBingoEvent(params.slug);
		if (!event) return fail(404, { error: 'Event not found' });
		if (event.status !== 'open') return fail(400, { error: 'Submissions are closed' });

		const form = await request.formData();
		const tileId = form.get('tile_id')?.toString() ?? '';
		const file = form.get('proof');

		if (!BINGO_TILE_BY_ID[tileId]) return fail(400, { error: 'Unknown tile' });
		if (!(file instanceof File)) return fail(400, { error: 'Missing proof image' });
		if (!tileIsSubmittable(tileId, (event.starts_at ?? event.signup_opens_at))) {
			return fail(400, { error: 'That tile is not open for submissions' });
		}

		const { data: existing } = await db()
			.from('vs_bingo_completions')
			.select('id, proof_path')
			.eq('event_id', event.id)
			.eq('user_id', locals.user.id)
			.eq('tile_id', tileId)
			.maybeSingle();
		if (existing) return fail(409, { error: 'You already submitted this tile — use Replace.' });

		const result = await uploadProof(event.id, locals.user.id, tileId, file);
		if ('error' in result) return fail(400, { error: result.error });

		const { error: insErr } = await db().from('vs_bingo_completions').insert({
			event_id: event.id,
			user_id: locals.user.id,
			tile_id: tileId,
			proof_url: result.url,
			proof_path: result.path
		});
		if (insErr) {
			await removeStorageObject(result.path);
			return fail(500, { error: insErr.message });
		}

		return { ok: true, action: 'submit' as const, tile_id: tileId };
	},

	replace: async ({ params, locals, request }) => {
		if (!locals.user) throw redirect(303, '/');
		requireBingoSlug(params.slug);

		const event = await fetchBingoEvent(params.slug);
		if (!event) return fail(404, { error: 'Event not found' });
		if (event.status !== 'open') return fail(400, { error: 'Submissions are closed' });

		const form = await request.formData();
		const tileId = form.get('tile_id')?.toString() ?? '';
		const file = form.get('proof');

		if (!BINGO_TILE_BY_ID[tileId]) return fail(400, { error: 'Unknown tile' });
		if (!(file instanceof File)) return fail(400, { error: 'Missing proof image' });
		if (!tileIsSubmittable(tileId, (event.starts_at ?? event.signup_opens_at))) {
			return fail(400, { error: 'That tile is locked' });
		}

		const { data: existing } = await db()
			.from('vs_bingo_completions')
			.select('id, proof_path')
			.eq('event_id', event.id)
			.eq('user_id', locals.user.id)
			.eq('tile_id', tileId)
			.maybeSingle();
		if (!existing) return fail(404, { error: 'No existing submission to replace' });

		const result = await uploadProof(event.id, locals.user.id, tileId, file);
		if ('error' in result) return fail(400, { error: result.error });

		const { error: updErr } = await db()
			.from('vs_bingo_completions')
			.update({
				proof_url: result.url,
				proof_path: result.path,
				submitted_at: new Date().toISOString()
			})
			.eq('id', existing.id);

		if (updErr) {
			await removeStorageObject(result.path);
			return fail(500, { error: updErr.message });
		}

		if (existing.proof_path && existing.proof_path !== result.path) {
			await removeStorageObject(existing.proof_path);
		}

		return { ok: true, action: 'replace' as const, tile_id: tileId };
	},

	remove: async ({ params, locals, request }) => {
		if (!locals.user) throw redirect(303, '/');
		requireBingoSlug(params.slug);

		const event = await fetchBingoEvent(params.slug);
		if (!event) return fail(404, { error: 'Event not found' });

		const form = await request.formData();
		const tileId = form.get('tile_id')?.toString() ?? '';
		if (!BINGO_TILE_BY_ID[tileId]) return fail(400, { error: 'Unknown tile' });
		if (!tileIsSubmittable(tileId, (event.starts_at ?? event.signup_opens_at))) {
			return fail(400, { error: 'You can only remove submissions while the tile is open' });
		}

		const { data: existing } = await db()
			.from('vs_bingo_completions')
			.select('id, proof_path')
			.eq('event_id', event.id)
			.eq('user_id', locals.user.id)
			.eq('tile_id', tileId)
			.maybeSingle();
		if (!existing) return { ok: true, action: 'remove' as const, tile_id: tileId };

		const { error: delErr } = await db()
			.from('vs_bingo_completions')
			.delete()
			.eq('id', existing.id);
		if (delErr) return fail(500, { error: delErr.message });

		if (existing.proof_path) {
			await removeStorageObject(existing.proof_path);
		}

		return { ok: true, action: 'remove' as const, tile_id: tileId };
	}
};

export const _allTiles = BINGO_TILES;
