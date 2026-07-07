import { memberEndpoint } from '$lib/server/apiEndpoint';
import { isAdmin } from '$lib/server/auth';
import { buildSections } from '$lib/server/eventsList';
import type { RequestHandler } from './$types';

// Data for the /events list page (instant navigation).
export const GET: RequestHandler = memberEndpoint((user) => buildSections(user.id, isAdmin(user)));
