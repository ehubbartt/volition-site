import { json, error } from '@sveltejs/kit';
import { buildMeData } from '$lib/server/meData';
import type { RequestHandler } from './$types';

// Data for the /me profile page. The page has NO server load — its universal
// load fires this fetch without awaiting it, so navigating to /me completes
// instantly and this streams in behind the skeleton.
export const GET: RequestHandler = async ({ locals }) => {
	if (!locals.user) throw error(401, 'Not signed in');
	const data = await buildMeData(locals.user);
	return json(data, { headers: { 'cache-control': 'no-store' } });
};
