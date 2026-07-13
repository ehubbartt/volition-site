import { fail } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { isAdmin } from '$lib/server/auth';
import type { Actions } from './$types';

// Actions for the wallet panel — the page data itself comes from
// /api/admin/wallets via the universal load in +page.ts (instant navigation).

export const actions: Actions = {
	// Zero a player's GP balance (manual correction — GP is site-only, not an in-game payout). Audit-logged
	// automatically by the hook (it's an admin action). Targets the player's serial id.
	settleGp: async ({ locals, request }) => {
		if (!locals.user || !isAdmin(locals.user)) return fail(403, { error: 'Not allowed' });
		const form = await request.formData();
		const id = form.get('id')?.toString();
		if (!id) return fail(400, { error: 'Missing player id' });
		const { error: upErr } = await db().from('players').update({ gold_balance: 0 }).eq('id', id);
		if (upErr) return fail(500, { error: upErr.message });
		return { ok: true };
	}
};
