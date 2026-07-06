import { json, error } from '@sveltejs/kit';
import { buildGambaData } from '$lib/server/gambaPage';
import type { RequestHandler } from './$types';

// Data for the /gamba page (store, balances, crate, tickers). The page has NO
// server load — its universal load fires this fetch without awaiting it, so
// navigating to /gamba completes instantly and this streams in behind skeletons.
export const GET: RequestHandler = async ({ locals }) => {
	if (!locals.user) throw error(401, 'Not signed in');
	const data = await buildGambaData(locals.user);
	return json(data, { headers: { 'cache-control': 'no-store' } });
};
