import { adminEndpoint } from '$lib/server/apiEndpoint';
import { buildVoice } from '$lib/server/admin/voice';
import type { RequestHandler } from './$types';

// Data for /admin/voice (instant navigation). adminEndpoint re-checks the
// admin role server-side on every fetch.
export const GET: RequestHandler = adminEndpoint(() => buildVoice());
