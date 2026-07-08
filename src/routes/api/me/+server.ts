import { memberEndpoint } from '$lib/server/apiEndpoint';
import { buildMeData } from '$lib/server/meData';
import type { RequestHandler } from './$types';

// Data for the /me profile page (instant navigation — see docs/PAGES.md).
export const GET: RequestHandler = memberEndpoint((user) => buildMeData(user));
