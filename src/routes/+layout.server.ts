import { isAdmin, isCardTester, isSuperAdmin } from '$lib/server/auth';
import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = ({ locals }) => {
	const user = locals.user;

	return {
		user,
		// Role flags follow any active view-as preview (see hooks.server.ts), so the
		// nav/guards render exactly what the previewed role would see…
		isAdmin: isAdmin(user),
		isCardTester: isCardTester(user),
		isSuperAdmin: isSuperAdmin(user),
		// …while these two drive the switcher itself from the REAL identity.
		realSuperAdmin: locals.realSuperAdmin,
		viewAs: user?.view_as ?? null,
		banned: !!locals.ban,
		// Current site theme (cookie-backed; SSR sets <html data-theme> from it). The
		// /me picker uses this as its initial selection.
		theme: locals.theme
	};
};
