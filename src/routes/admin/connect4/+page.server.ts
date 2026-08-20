import { redirect, fail } from '@sveltejs/kit';
import { isAdmin } from '$lib/server/auth';
import { createConnect4, deleteConnect4, listConnect4Games } from '$lib/server/connect4';
import { DEFAULT_SCORING } from '$lib/connect4/rules';
import type { Actions, PageServerLoad } from './$types';

// Connect Four game list + creation. Form-heavy and rare, so it keeps a classic server
// load rather than the instant-nav pattern (see docs/PAGES.md).

function slugify(name: string): string {
	return name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 60);
}

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) throw redirect(303, '/');
	if (!isAdmin(locals.user)) throw redirect(303, '/');
	return { games: await listConnect4Games(), defaults: DEFAULT_SCORING };
};

export const actions: Actions = {
	create: async ({ request, locals }) => {
		if (!locals.user || !isAdmin(locals.user)) return fail(403, { error: 'Admins only' });
		const form = await request.formData();
		const name = String(form.get('name') ?? '').trim();
		if (!name) return fail(400, { error: 'Give the game a name' });
		const slug = slugify(String(form.get('slug') ?? '') || name);
		if (!slug) return fail(400, { error: 'That name produces an empty slug' });

		const num = (key: string, fallback: number) => {
			const raw = form.get(key);
			const n = Number(raw);
			return raw === null || raw === '' || !isFinite(n) ? fallback : n;
		};

		// The line table is authored as four rows (4/5/6/7); extra_per_cell covers anything
		// longer, so the form never needs an open-ended list.
		const lineLens = [4, 5, 6, 7];
		const created = await createConnect4({
			slug,
			name,
			description: String(form.get('description') ?? '').trim() || null,
			ownerUserId: locals.user.id,
			sideNames: [
				String(form.get('side1') ?? '').trim() || 'Red',
				String(form.get('side2') ?? '').trim() || 'Yellow'
			],
			scoring: {
				tile_points: num('tile_points', DEFAULT_SCORING.tile_points),
				line_points: lineLens.map((len, i) => ({
					len,
					points: num(`line_${len}`, DEFAULT_SCORING.line_points[i]?.points ?? 0)
				})),
				extra_per_cell: num('extra_per_cell', DEFAULT_SCORING.extra_per_cell)
			},
			test: form.get('test') === 'on'
		});
		if (!created.ok) return fail(400, { error: created.error });
		throw redirect(303, `/admin/connect4/${created.value!.slug}`);
	},

	remove: async ({ request, locals }) => {
		if (!locals.user || !isAdmin(locals.user)) return fail(403, { error: 'Admins only' });
		const form = await request.formData();
		const id = String(form.get('id') ?? '');
		const res = await deleteConnect4(id);
		return res.ok ? { removed: true } : fail(400, { error: res.error });
	}
};
