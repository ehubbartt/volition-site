import { instantLoad } from '$lib/instantLoad';
import type { buildVoice } from '$lib/server/admin/voice';
import type { PageLoad } from './$types';

// Type-only import above is erased at build time. The 'admin' guard is UX only —
// the /api/admin endpoint re-checks the role on every fetch.
export type VoiceData = Awaited<ReturnType<typeof buildVoice>>;

export const load: PageLoad = instantLoad<VoiceData, 'voice'>({
	key: 'voice',
	guard: 'admin',
	url: '/api/admin/voice'
});
