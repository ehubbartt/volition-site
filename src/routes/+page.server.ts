import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = ({ locals }) => {
	if (locals.user) {
		if (!locals.user.rsn || !locals.user.clan_allegiance || !locals.user.account_type) {
			throw redirect(303, '/onboarding');
		}
		throw redirect(303, '/events');
	}
	return {};
};
