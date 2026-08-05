import { redirect, error, fail } from '@sveltejs/kit';
import { isAdmin } from '$lib/server/auth';
import { listGearClaimsForReview, reviewGearClaim } from '$lib/server/rankClaims';
import type { Actions, PageServerLoad } from './$types';

// Admin review queue for manual rank gear claims (vs_rank_item_claims) — items the
// Temple collection log can't prove (GE-bought pieces, upgraded variants combined
// outside the log). Approving merges the item into the member's gear score on their
// next rank check / the next rank-sim refresh; nothing is re-scored retroactively.

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) throw redirect(303, '/');
	if (!isAdmin(locals.user)) throw error(403, 'Not allowed');
	const { pending, decided } = await listGearClaimsForReview();
	return { pending, decided };
};

export const actions: Actions = {
	review: async ({ locals, request }) => {
		if (!locals.user || !isAdmin(locals.user)) throw error(403, 'Not allowed');
		const form = await request.formData();
		const id = Math.floor(Number(form.get('id')));
		const approve = form.get('decision') === 'approve';
		const note = (form.get('review_note') ?? '').toString().trim() || null;
		if (!Number.isFinite(id)) return fail(400, { reviewError: 'Unknown claim.' });
		const res = await reviewGearClaim(id, approve, locals.user.id, note);
		if (!res.ok) return fail(500, { reviewError: res.error ?? 'Review failed.' });
		return { reviewed: id, approved: approve };
	}
};
