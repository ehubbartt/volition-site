import { error } from '@sveltejs/kit';
import { adminEndpoint } from '$lib/server/apiEndpoint';
import { buildVoiceUser } from '$lib/server/admin/voice';
import type { RequestHandler } from './$types';

// One member's voice history, for the drill-down on /admin/voice. adminEndpoint
// re-checks the admin role server-side on every fetch.
export const GET: RequestHandler = adminEndpoint(async (_user, event) => {
	const detail = await buildVoiceUser(event.params.userId ?? '');
	if (!detail) throw error(404, 'No voice activity tracked for that user');
	return detail;
});
