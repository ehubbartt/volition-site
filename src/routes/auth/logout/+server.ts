import { redirect } from '@sveltejs/kit';
import { destroySession } from '$lib/server/auth';
import type { RequestHandler } from './$types';

const logout: RequestHandler = async ({ cookies }) => {
	await destroySession(cookies);
	throw redirect(303, '/');
};

export const POST = logout;
// The staging-lock page links logout as a plain <a href> (hooks.server.ts renders
// raw HTML before the app exists), which issues a GET.
export const GET = logout;
