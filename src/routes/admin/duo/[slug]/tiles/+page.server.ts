import { redirect, error, fail } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { isAdmin } from '$lib/server/auth';
import { duoNodeRefs, type DuoNodeRef } from '$lib/board/config';
import {
	DUO_WOLF_EVENT_SLUG,
	DUO_TILE_IDS,
	getDuoTileName,
	getDuoTileImg,
	getDuoTileRequired,
	getDuoTileFaq,
	getDuoTilePrePic,
	getDuoTileAutoClear
} from '$lib/server/duoWolfTiles';
import {
	ensureDuoTilesFresh,
	listDuoTileOverrideIds,
	saveDuoTile,
	resetDuoTile
} from '$lib/server/duoTileStore';
import type { Actions, PageServerLoad } from './$types';

function requireDuoWolf(slug: string): void {
	if (slug !== DUO_WOLF_EVENT_SLUG) throw error(404, 'Not found');
}

// Subgroup header within a floor (start / each section / intermissions / boss), in board order.
function groupOf(ref: DuoNodeRef): string {
	if (ref.kind === 'start') return 'Start';
	if (ref.kind === 'boss') return 'Boss';
	if (ref.kind === 'mid') return `Intermission · after Section ${ref.section}`;
	return `Section ${ref.section}`;
}

// Human label for a single tile within its group.
function tileLabel(ref: DuoNodeRef): string {
	if (ref.kind === 'start') return 'Start tile';
	if (ref.kind === 'boss') return 'Boss room';
	if (ref.kind === 'mid') return `Intermission (after Section ${ref.section})`;
	return `Path ${(ref.lane ?? 0) + 1} · Step ${(ref.step ?? 0) + 1}`;
}

export const load: PageServerLoad = async ({ params, locals }) => {
	if (!locals.user) throw redirect(303, '/');
	if (!isAdmin(locals.user)) throw error(403, 'Not allowed');
	requireDuoWolf(params.slug);

	const { data: event, error: evErr } = await db()
		.from('vs_events')
		.select('id, slug, name, status')
		.eq('slug', params.slug)
		.maybeSingle();
	if (evErr) throw error(500, evErr.message);
	if (!event) throw error(404, 'Event not found');

	// Force-fresh so the editor always shows the current saved values.
	await ensureDuoTilesFresh(true);
	const overridden = await listDuoTileOverrideIds();

	const tiles = duoNodeRefs().map((ref) => {
		const prePic = getDuoTilePrePic(ref.id);
		return {
			id: ref.id,
			floor: ref.floor,
			kind: ref.kind,
			group: groupOf(ref),
			label: tileLabel(ref),
			name: getDuoTileName(ref.id) ?? '',
			img: getDuoTileImg(ref.id) ?? '',
			required: getDuoTileRequired(ref.id),
			faq: getDuoTileFaq(ref.id) ?? '',
			prePic: !!prePic,
			postRequired: prePic?.postRequired ?? false,
			autoClear: getDuoTileAutoClear(ref.id) ?? '',
			overridden: overridden.has(ref.id)
		};
	});

	return { event: { slug: event.slug, name: event.name, status: event.status }, tiles };
};

export const actions: Actions = {
	// Upsert one tile's content (creates/updates its vs_duo_tiles override row). Audited
	// automatically by the hooks interceptor (admin POST).
	saveTile: async ({ params, locals, request }) => {
		if (!locals.user) throw redirect(303, '/');
		if (!isAdmin(locals.user)) return fail(403, { error: 'Not allowed' });
		requireDuoWolf(params.slug);

		const form = await request.formData();
		const nodeId = form.get('node_id')?.toString() ?? '';
		if (!DUO_TILE_IDS.has(nodeId)) return fail(400, { error: 'Unknown tile' });

		const name = form.get('name')?.toString().trim() ?? '';
		if (!name) return fail(400, { error: 'Name is required' });
		const img = form.get('img')?.toString().trim() ?? '';
		const required = Math.max(1, Math.floor(Number(form.get('required')) || 1));
		const faq = form.get('faq')?.toString() ?? '';
		const pre_pic = form.get('pre_pic') === 'on';
		const pre_pic_post_required = pre_pic && form.get('post_required') === 'on';
		const auto_clear = form.get('auto_clear')?.toString().trim() || null;

		const res = await saveDuoTile({
			node_id: nodeId,
			name,
			img,
			required,
			faq,
			pre_pic,
			pre_pic_post_required,
			auto_clear,
			updated_by: locals.user.id
		});
		if (!res.ok) return fail(500, { error: res.error });
		return { ok: true, savedId: nodeId };
	},

	// Drop the override row → tile reverts to the hardcoded default.
	resetTile: async ({ params, locals, request }) => {
		if (!locals.user) throw redirect(303, '/');
		if (!isAdmin(locals.user)) return fail(403, { error: 'Not allowed' });
		requireDuoWolf(params.slug);

		const form = await request.formData();
		const nodeId = form.get('node_id')?.toString() ?? '';
		if (!DUO_TILE_IDS.has(nodeId)) return fail(400, { error: 'Unknown tile' });

		const res = await resetDuoTile(nodeId);
		if (!res.ok) return fail(500, { error: res.error });
		return { ok: true, resetId: nodeId };
	}
};
