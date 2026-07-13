import { memberEndpoint } from '$lib/server/apiEndpoint';
import { buildGambaData } from '$lib/server/gambaPage';
import type { RequestHandler } from './$types';

// Data for the /gamba page — store, balances, crate, tickers (instant navigation).
export const GET: RequestHandler = memberEndpoint((user) => buildGambaData(user));
