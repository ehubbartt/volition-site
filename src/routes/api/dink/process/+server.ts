// POST /api/dink/process — drains vs_dink_drops and auto-credits matching bingo
// tiles. Called by a cron / the dink-proxy after writes. Guarded by a shared
// secret (DINK_PROCESS_SECRET): send it as `Authorization: Bearer <secret>` or
// `?key=<secret>`. If the secret isn't configured the endpoint is disabled (403)
// so it can't be hit anonymously in environments that haven't set it up.

import { json, error } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { processDinkDrops } from '$lib/server/dinkDrops';
import type { RequestHandler } from './$types';

function authorized(request: Request, url: URL): boolean {
	const secret = env.DINK_PROCESS_SECRET;
	if (!secret) return false;
	const header = request.headers.get('authorization') ?? '';
	const bearer = header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : '';
	return bearer === secret || url.searchParams.get('key') === secret;
}

export const POST: RequestHandler = async ({ request, url }) => {
	if (!authorized(request, url)) throw error(403, 'forbidden');
	// The cron/proxy path also runs a bounded reconcile pass (re-check recent un-credited
	// drops against the current view) to heal ordering races. The poll-on-read backstop
	// stays drain-only so it remains cheap.
	const result = await processDinkDrops({ reconcile: true });
	return json(result);
};
