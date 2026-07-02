import { redirect, error, fail } from '@sveltejs/kit';
import { isAdmin } from '$lib/server/auth';
import { createGame, deleteGame, listGames } from '$lib/server/catan';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) throw redirect(303, '/');
	if (!isAdmin(locals.user)) throw error(403, 'Not allowed');
	return { games: await listGames() };
};

export const actions: Actions = {
	create: async ({ locals, request }) => {
		if (!locals.user || !isAdmin(locals.user)) throw error(403, 'Not allowed');
		const form = await request.formData();
		const name = form.get('name')?.toString().trim() || 'Gielinor Catan test';
		const seedRaw = form.get('seed')?.toString().trim();
		const seed = seedRaw ? Number(seedRaw) : undefined;
		if (seedRaw && (!Number.isInteger(seed) || seed! < 0))
			return fail(400, { error: 'Seed must be a non-negative integer' });

		const res = await createGame(name, locals.user.id, seed);
		if (!res.ok) return fail(500, { error: res.error });
		throw redirect(303, `/admin/catan/${res.slug}`);
	},

	delete: async ({ locals, request }) => {
		if (!locals.user || !isAdmin(locals.user)) throw error(403, 'Not allowed');
		const form = await request.formData();
		const eventId = form.get('event_id')?.toString();
		if (!eventId) return fail(400, { error: 'Missing event id' });
		const res = await deleteGame(eventId);
		if (!res.ok) return fail(500, { error: res.error });
		return { ok: true };
	}
};
