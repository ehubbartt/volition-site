import { json, error } from '@sveltejs/kit';
import { isAdmin } from '$lib/server/auth';
import { buildSections } from '$lib/server/eventsList';
import type { RequestHandler } from './$types';

// Data for the /events list page. The page itself has NO server load — its
// universal load fires this fetch without awaiting it, so navigating to /events
// completes instantly (skeletons) and this response streams in behind it.
export const GET: RequestHandler = async ({ locals }) => {
	if (!locals.user) throw error(401, 'Not signed in');
	const sections = await buildSections(locals.user.id, isAdmin(locals.user));
	return json(sections, { headers: { 'cache-control': 'no-store' } });
};
