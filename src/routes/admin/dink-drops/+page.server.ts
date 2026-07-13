import { error, fail } from '@sveltejs/kit';
import { isAdmin } from '$lib/server/auth';
import { revertDinkCredit, reprocessDinkDrop } from '$lib/server/dinkDrops';
import type { Actions } from './$types';

// Actions for the dink-drops debugging view — reverse a wrong credit or re-run a
// drop. The page data itself comes from /api/admin/dink-drops via the universal
// load in +page.ts (instant navigation).

export const actions: Actions = {
	uncredit: async ({ locals, request }) => {
		if (!locals.user || !isAdmin(locals.user)) throw error(403, 'Not allowed');
		const id = Number((await request.formData()).get('id'));
		if (!Number.isFinite(id)) return fail(400, { error: 'Bad id' });
		const res = await revertDinkCredit(id);
		return res.ok ? { ok: true, msg: 'Credit reverted.' } : fail(400, { error: res.error });
	},
	reprocess: async ({ locals, request }) => {
		if (!locals.user || !isAdmin(locals.user)) throw error(403, 'Not allowed');
		const id = Number((await request.formData()).get('id'));
		if (!Number.isFinite(id)) return fail(400, { error: 'Bad id' });
		const res = await reprocessDinkDrop(id);
		return res.error
			? fail(400, { error: res.error })
			: { ok: true, msg: `Reprocessed — credited ${res.credited}.` };
	}
};
