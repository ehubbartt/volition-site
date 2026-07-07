import { json, error } from '@sveltejs/kit';
import { buildEventTaskDetail } from '$lib/server/eventTaskPage';
import type { RequestHandler } from './$types';

// Data for the generic /event/[slug] task-event page. The page has NO server
// load — its universal load fires this fetch without awaiting it; not-found and
// bespoke-page redirects ride in the payload.
export const GET: RequestHandler = async ({ locals, params }) => {
	if (!locals.user) throw error(401, 'Not signed in');
	const detail = await buildEventTaskDetail(locals.user, params.slug);
	return json(detail, { headers: { 'cache-control': 'no-store' } });
};
