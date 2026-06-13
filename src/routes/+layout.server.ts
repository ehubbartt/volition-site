import { isAdmin, isCardTester } from '$lib/server/auth';
import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = ({ locals }) => {
	const user = locals.user;

	return {
		user,
		isAdmin: isAdmin(user),
		isCardTester: isCardTester(user),
		banned: !!locals.ban
	};
};
