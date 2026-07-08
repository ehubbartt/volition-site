import { redirect } from '@sveltejs/kit';
import { destroySession } from '$lib/server/auth';
import type { RequestHandler } from './$types';

// POST only, on purpose: a GET logout can be triggered cross-origin by an
// <img src>/prefetcher and would let a third party force-log-out users. The
// staging-lock notice and the /me + /banned pages all log out via a POST form.
export const POST: RequestHandler = async ({ cookies }) => {
	await destroySession(cookies);
	throw redirect(303, '/');
};
