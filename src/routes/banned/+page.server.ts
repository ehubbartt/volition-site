import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

// Shown to banned users (hooks.server.ts redirects every other route here). If the
// viewer isn't actually banned, there's nothing to see — send them home.
export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.ban) throw redirect(303, '/');
	return {
		reason: locals.ban.reason,
		bannedAt: locals.ban.created_at,
		name: locals.user?.rsn ?? locals.user?.discord_username ?? null
	};
};
