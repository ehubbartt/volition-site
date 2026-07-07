import { json, error } from '@sveltejs/kit';
import { buildPersonalBoardData } from '$lib/server/personalBoardPage';
import type { RequestHandler } from './$types';

// Data for the /events/personal-bingo page. The page has NO server load — its
// universal load fires this fetch without awaiting it, so navigating there is
// instant and this streams in behind the tile-skeleton grid.
export const GET: RequestHandler = async ({ locals }) => {
	if (!locals.user) throw error(401, 'Not signed in');
	const data = await buildPersonalBoardData(locals.user);
	return json(data, { headers: { 'cache-control': 'no-store' } });
};
