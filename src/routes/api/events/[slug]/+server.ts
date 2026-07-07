import { memberEndpoint } from '$lib/server/apiEndpoint';
import { buildEventDetail } from '$lib/server/eventDetail';
import type { RequestHandler } from './$types';

// Data for the /events/[slug] detail page (instant navigation); not-found and
// redirect outcomes ride in the payload and only FRESH responses steer the client.
export const GET: RequestHandler = memberEndpoint((user, event) =>
	buildEventDetail(user, event.params.slug!, {
		teamsView: event.url.searchParams.get('view') === 'teams',
		demo: event.url.searchParams.get('demo') === '1'
	})
);
