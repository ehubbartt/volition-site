import { isAdmin, isCardTester } from '$lib/server/auth';
import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = ({ locals }) => {
	return {
		user: locals.user,
		isAdmin: isAdmin(locals.user),
		isCardTester: isCardTester(locals.user)
	};
};
