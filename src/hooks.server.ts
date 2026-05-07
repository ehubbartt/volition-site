import type { Handle } from '@sveltejs/kit';
import { readSession } from '$lib/server/auth';

export const handle: Handle = async ({ event, resolve }) => {
	const session = await readSession(event.cookies);
	event.locals.user = session?.user ?? null;
	event.locals.sessionId = session?.sessionId ?? null;
	return resolve(event);
};
