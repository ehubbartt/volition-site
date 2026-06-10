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
		// To Do nav badge count. The To Do nav item is card-tester-gated, so only
		// compute it for them. Returned as a PROMISE (streamed) — the root layout
		// wraps every page, so this must never block navigation; the badge fills in
		// once it resolves.
		todoCount: cardTester && onboarded && user ? loadTodoBadgeCount(user) : Promise.resolve(0)
	};
};
