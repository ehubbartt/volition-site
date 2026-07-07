import { memberEndpoint } from '$lib/server/apiEndpoint';
import { buildEventTaskDetail } from '$lib/server/eventTaskPage';
import type { RequestHandler } from './$types';

// Data for the generic /event/[slug] task-event page (instant navigation);
// not-found and bespoke-page redirects ride in the payload.
export const GET: RequestHandler = memberEndpoint((user, event) =>
	buildEventTaskDetail(user, event.params.slug!)
);
