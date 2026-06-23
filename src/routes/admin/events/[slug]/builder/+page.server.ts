import { redirect, error, fail } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { isAdmin } from '$lib/server/auth';
import { normalizeBingoStructure, type BingoStructure, type BingoTierConfig } from '$lib/bingo/config';
import {
	loadEventBoard,
	listTrackedItems,
	listTemplates,
	cloneTemplateToEvent,
	updateEventStructure,
	saveEventTile,
	deleteEventTile,
	saveTrackedItem,
	deleteTrackedItem
} from '$lib/server/eventStructure';
import type { Actions, PageServerLoad } from './$types';

async function fetchEvent(slug: string) {
	const { data, error: qErr } = await db()
		.from('vs_events')
		.select('id, slug, name, kind, status, structure')
		.eq('slug', slug)
		.maybeSingle();
	if (qErr) throw error(500, qErr.message);
	return data as
		| { id: string; slug: string; name: string; kind: string | null; status: string; structure: unknown }
		| null;
}

export const load: PageServerLoad = async ({ params, locals }) => {
	if (!locals.user) throw redirect(303, '/');
	if (!isAdmin(locals.user)) throw error(403, 'Not allowed');

	const event = await fetchEvent(params.slug);
	if (!event) throw error(404, 'Event not found');

	const board = await loadEventBoard(event);
	const trackedItems = await listTrackedItems(event.id);

	return {
		event: { id: event.id, slug: event.slug, name: event.name, kind: event.kind, status: event.status },
		built: board.built,
		structure: board.structure,
		tiles: board.tiles.map((t) => ({
			id: t.id,
			name: t.name,
			tier: t.tier,
			row: t.row,
			points: t.points,
			img: t.img ?? null
		})),
		// Raw markdown details per tile (board.getDetails returns md for the builder editor).
		details: Object.fromEntries(board.tiles.map((t) => [t.id, board.getDetails(t.id) ?? ''])),
		trackedItems,
		templates: listTemplates()
	};
};

async function requireEvent(slug: string) {
	const event = await fetchEvent(slug);
	if (!event) return { error: fail(404, { error: 'Event not found' }), event: null };
	return { error: null, event };
}

function num(form: FormData, key: string, fallback = 0): number {
	const n = Number(form.get(key)?.toString().trim());
	return Number.isFinite(n) ? n : fallback;
}

// Stable, id-safe key for a new column derived from its label.
function slugifyKey(label: string): string {
	return label
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 24);
}

export const actions: Actions = {
	pickTemplate: async ({ locals, request, params }) => {
		if (!locals.user || !isAdmin(locals.user)) throw error(403, 'Not allowed');
		const guard = await requireEvent(params.slug);
		if (guard.error) return guard.error;

		const form = await request.formData();
		const templateSlug = form.get('template')?.toString() ?? '';
		if (!templateSlug) return fail(400, { error: 'Pick a template' });

		const res = await cloneTemplateToEvent(guard.event.id, templateSlug);
		if (!res.ok) return fail(500, { error: res.error });
		return { ok: true };
	},

	updateStructure: async ({ locals, request, params }) => {
		if (!locals.user || !isAdmin(locals.user)) throw error(403, 'Not allowed');
		const guard = await requireEvent(params.slug);
		if (guard.error) return guard.error;

		const form = await request.formData();
		const current = normalizeBingoStructure(guard.event.structure);

		// Columns arrive as parallel arrays col_key[]/col_label[]/col_points[]. A blank
		// key means a newly-added column → mint a stable slug; existing columns keep
		// their key so their tiles stay mapped on rename.
		const keys = form.getAll('col_key').map((v) => v.toString().trim());
		const labels = form.getAll('col_label').map((v) => v.toString().trim());
		const points = form.getAll('col_points').map((v) => Number(v.toString()));
		const used = new Set<string>();
		const mainTiers: BingoTierConfig[] = [];
		labels.forEach((label, i) => {
			if (!label) return; // drop blank columns
			let key = keys[i] || slugifyKey(label);
			if (!key) key = `col${i}`;
			while (used.has(key)) key = `${key}_`;
			used.add(key);
			mainTiers.push({ key, label, points: Math.max(0, Math.floor(points[i]) || 0) });
		});
		if (mainTiers.length === 0) return fail(400, { error: 'Add at least one column' });

		// Keep the bonus column config (label/points) even when disabled.
		const prevBonus = current.tiers.find((t) => t.key === 'bonus');
		const bonusTier: BingoTierConfig = {
			key: 'bonus',
			label: form.get('bonus_label')?.toString().trim() || prevBonus?.label || 'Bonus',
			points: Math.max(0, Math.floor(num(form, 'bonus_points', prevBonus?.points ?? 5))),
			color: '#ff981f'
		};

		const structure: BingoStructure = {
			rowCount: Math.max(1, Math.floor(num(form, 'rowCount', current.rowCount))),
			rowIntervalHours: Math.max(0.1, num(form, 'rowIntervalHours', current.rowIntervalHours)),
			bonusEnabled: form.get('bonusEnabled') != null,
			tiers: [...mainTiers, bonusTier]
		};
		const res = await updateEventStructure(guard.event.id, structure);
		if (!res.ok) return fail(500, { error: res.error });
		return { ok: true };
	},

	saveTile: async ({ locals, request, params }) => {
		if (!locals.user || !isAdmin(locals.user)) throw error(403, 'Not allowed');
		const guard = await requireEvent(params.slug);
		if (guard.error) return guard.error;

		const form = await request.formData();
		const res = await saveEventTile({
			event_id: guard.event.id,
			tile_id: form.get('tile_id')?.toString() ?? '',
			row: num(form, 'row', 1),
			tier: form.get('tier')?.toString() ?? 'skilling',
			name: form.get('name')?.toString() ?? '',
			points: num(form, 'points', 0),
			details_md: form.get('details_md')?.toString() ?? null,
			img: form.get('img')?.toString() ?? null
		});
		if (!res.ok) return fail(400, { error: res.error });
		return { ok: true };
	},

	deleteTile: async ({ locals, request, params }) => {
		if (!locals.user || !isAdmin(locals.user)) throw error(403, 'Not allowed');
		const guard = await requireEvent(params.slug);
		if (guard.error) return guard.error;

		const form = await request.formData();
		const tileId = form.get('tile_id')?.toString() ?? '';
		if (!tileId) return fail(400, { error: 'Missing tile' });
		const res = await deleteEventTile(guard.event.id, tileId);
		if (!res.ok) return fail(500, { error: res.error });
		return { ok: true };
	},

	addTrackedItem: async ({ locals, request, params }) => {
		if (!locals.user || !isAdmin(locals.user)) throw error(403, 'Not allowed');
		const guard = await requireEvent(params.slug);
		if (guard.error) return guard.error;

		const form = await request.formData();
		const itemIdRaw = form.get('item_id')?.toString().trim();
		const res = await saveTrackedItem({
			event_id: guard.event.id,
			tile_id: form.get('tile_id')?.toString() ?? '',
			item_id: itemIdRaw ? Math.floor(Number(itemIdRaw)) || null : null,
			item_name: form.get('item_name')?.toString() ?? '',
			required_qty: num(form, 'required_qty', 1),
			source_name: form.get('source_name')?.toString() ?? null
		});
		if (!res.ok) return fail(400, { error: res.error });
		return { ok: true };
	},

	deleteTrackedItem: async ({ locals, request }) => {
		if (!locals.user || !isAdmin(locals.user)) throw error(403, 'Not allowed');
		const form = await request.formData();
		const id = form.get('id')?.toString() ?? '';
		if (!id) return fail(400, { error: 'Missing id' });
		const res = await deleteTrackedItem(id);
		if (!res.ok) return fail(500, { error: res.error });
		return { ok: true };
	}
};
