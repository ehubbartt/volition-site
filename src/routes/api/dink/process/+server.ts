// POST /api/dink/process — drains vs_dink_drops and auto-credits matching bingo
// tiles. Called by a cron / the dink-proxy after writes. Guarded by a shared
// secret (DINK_PROCESS_SECRET): send it as `Authorization: Bearer <secret>` or
// `?key=<secret>`. If the secret isn't configured the endpoint is disabled (403)
// so it can't be hit anonymously in environments that haven't set it up.

import { json, error } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { runProcessDinkDrops } from '$lib/server/dinkDrops';
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
	// `reconcile` (default on, for hand-invocation compatibility) additionally runs the
	// bounded reconcile pass — re-checking recent un-credited drops against the current
	// view (e.g. a player who signed up AFTER their drop). The proxy's after-insert ping
	// sends reconcile=0 (it can fire every kill, and re-churning days of dead drops per
	// kill is waste); the worker's 15-minute cron sends reconcile=1. Runs are serialized
	// per instance — a burst of pings coalesces instead of stampeding.
	const reconcile = !/^(0|false|no|off)$/i.test(url.searchParams.get('reconcile') ?? '');
	const result = await runProcessDinkDrops({ reconcile });
	return json(result);
};
