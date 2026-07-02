import { redirect, error, fail } from '@sveltejs/kit';
import { z } from 'zod';
import { isAdmin } from '$lib/server/auth';
import { getTaskPools, saveTaskPools } from '$lib/server/catan';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) throw redirect(303, '/');
	if (!isAdmin(locals.user)) throw error(403, 'Not allowed');
	return { pools: await getTaskPools() };
};

const templateSchema = z.object({
	label: z.string().trim().min(1).max(80),
	unit: z.string().trim().min(1).max(24),
	perRating: z.coerce.number().positive().max(100_000)
});

const poolsSchema = z.object({
	boss: z.array(templateSchema).min(1).max(50),
	skilling: z.array(templateSchema).min(1).max(50),
	raids: z.array(templateSchema).min(1).max(50),
	custom: z.array(templateSchema).min(1).max(50)
});

export const actions: Actions = {
	save: async ({ locals, request }) => {
		if (!locals.user || !isAdmin(locals.user)) throw error(403, 'Not allowed');
		const form = await request.formData();
		let parsed: unknown;
		try {
			parsed = JSON.parse(form.get('pools')?.toString() ?? '');
		} catch {
			return fail(400, { error: 'Malformed task pools payload' });
		}
		const pools = poolsSchema.safeParse(parsed);
		if (!pools.success) {
			const issue = pools.error.issues[0];
			return fail(400, { error: `Invalid task list (${issue.path.join('.')}: ${issue.message})` });
		}
		const res = await saveTaskPools(pools.data);
		if (!res.ok) return fail(500, { error: res.error });
		return { ok: true, saved: true };
	}
};
