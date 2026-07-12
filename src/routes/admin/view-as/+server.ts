import { error, redirect } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

// Super-admin-only "view as" switcher (see hooks.server.ts). Sets/clears the
// vs_view_as cookie via a NATIVE form post from the layout widget — the full
// document load that causes is deliberate: it wipes the client-side swr cache,
// so payloads fetched under a higher role can never first-paint in a lower-role
// preview. Gated on locals.realSuperAdmin (the RAW identity), so a super admin
// currently previewing a lower role can still switch back.
const ROLES = new Set(['admin', 'member', 'guest']);

export const POST: RequestHandler = async ({ locals, request, cookies }) => {
	if (!locals.realSuperAdmin) throw error(403, 'Not allowed');

	const role = ((await request.formData()).get('role') ?? '').toString();
	if (role === 'super') {
		cookies.delete('vs_view_as', { path: '/' });
	} else if (ROLES.has(role)) {
		cookies.set('vs_view_as', role, {
			path: '/',
			httpOnly: true,
			secure: process.env.NODE_ENV === 'production',
			sameSite: 'lax',
			maxAge: 60 * 60 * 8 // preview expires on its own after a work day
		});
	} else {
		throw error(400, 'Unknown role');
	}

	// Land on the homepage — a safe destination for every preview role (the page
	// being viewed might 403/404 under the new role).
	throw redirect(303, '/');
};
