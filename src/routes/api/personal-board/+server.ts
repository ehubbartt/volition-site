import { memberEndpoint } from '$lib/server/apiEndpoint';
import { buildPersonalBoardData } from '$lib/server/personalBoardPage';
import type { RequestHandler } from './$types';

// Data for the /events/personal-bingo page (instant navigation).
export const GET: RequestHandler = memberEndpoint((user) => buildPersonalBoardData(user));
