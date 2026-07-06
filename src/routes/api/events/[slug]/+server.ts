import { json, error } from '@sveltejs/kit';
import { buildEventDetail } from '$lib/server/eventDetail';
import type { RequestHandler } from './$types';

// Data for the /events/[slug] detail page. The page has NO server load — its
// universal load fires this fetch without awaiting it, so navigating to an event
// lands instantly on a skeleton; not-found and redirect outcomes come back in the
// payload and the client acts on them when it arrives.
export const GET: RequestHandler = async ({ locals, params, url }) => {
	if (!locals.user) throw error(401, 'Not signed in');
	const detail = await buildEventDetail(locals.user, params.slug, {
		teamsView: url.searchParams.get('view') === 'teams',
		demo: url.searchParams.get('demo') === '1'
	});
	return json(detail, { headers: { 'cache-control': 'no-store' } });
};
