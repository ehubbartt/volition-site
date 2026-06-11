import { redirect, fail } from '@sveltejs/kit';
import { loadPlayerTasks } from '$lib/server/tasks';
import { claimWeeklyPack } from '$lib/server/weeklyPack';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) throw redirect(303, '/');
	if (!locals.user.rsn || !locals.user.clan_allegiance || !locals.user.account_type) {
		throw redirect(303, '/onboarding');
	}

	const tasks = await loadPlayerTasks(locals.user);
	return { tasks };
};

export const actions: Actions = {
	// Claim this week's free pack (clan members; once per week). The card flips to
	// "done" on the load that re-runs after this returns.
	claimWeeklyPack: async ({ locals }) => {
		if (!locals.user) throw redirect(303, '/');
		const res = await claimWeeklyPack(locals.user);
		if (!res.ok) {
			const msg =
				res.reason === 'already'
					? "You've already claimed this week's pack — come back after the weekly reset."
					: res.reason === 'not_member'
						? 'Only Volition clan members can claim the weekly pack.'
						: res.reason === 'none'
							? 'There is no weekly pack set up right now.'
							: 'Could not claim the weekly pack — please try again.';
			return fail(400, { error: msg });
		}
		return { ok: true, claimed: res.packName };
	}
};
