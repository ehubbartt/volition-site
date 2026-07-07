import { isAdmin, isCardTester, isSuperAdmin } from '$lib/server/auth';
import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = ({ locals }) => {
	const user = locals.user;

	return {
		user,
		isAdmin: isAdmin(user),
		isCardTester: isCardTester(user),
		isSuperAdmin: isSuperAdmin(user),
		banned: !!locals.ban
	};
};
