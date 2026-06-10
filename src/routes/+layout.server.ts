import { isAdmin, isCardTester } from '$lib/server/auth';
import { loadTodoBadgeCount } from '$lib/server/tasks';
import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = ({ locals }) => {
	const user = locals.user;
	const cardTester = isCardTester(user);
	const onboarded = !!(user?.rsn && user.clan_allegiance && user.account_type);

	return {
		user,
		isAdmin: isAdmin(user),
		isCardTester: cardTester,
		// To Do nav badge count — for every onboarded user (the To Do list is open to
		// all). Returned as a PROMISE (streamed) — the root layout wraps every page,
		// so this must never block navigation; the badge fills in once it resolves.
		todoCount: onboarded && user ? loadTodoBadgeCount(user) : Promise.resolve(0)
	};
};
