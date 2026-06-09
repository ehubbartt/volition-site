import { redirect, error, fail } from '@sveltejs/kit';
import { isCardTester } from '$lib/server/auth';
import { sendBridgeTest, isBridgeConfigured } from '$lib/server/botBridge';
import type { Actions, PageServerLoad } from './$types';

// Card-tester-gated dev tool: fire a harmless `ping` through the site→bot webhook
// bridge to confirm it delivers (without waiting on a rare role roll).
export const load: PageServerLoad = ({ locals }) => {
	if (!locals.user) throw redirect(303, '/');
	if (!isCardTester(locals.user)) throw error(403, 'Not allowed');
	return { configured: isBridgeConfigured() };
};

export const actions: Actions = {
	default: async ({ locals, request }) => {
		if (!locals.user || !isCardTester(locals.user)) throw error(403, 'Not allowed');

		const form = await request.formData();
		const note = (form.get('note')?.toString() ?? '').trim().slice(0, 200);
		const res = await sendBridgeTest(note || `test by ${locals.user.discord_username}`);

		if (!res.ok) {
			return fail(400, { sent: false, message: res.error ?? `HTTP ${res.status ?? '?'}` });
		}
		return { sent: true, status: res.status ?? 204 };
	}
};
