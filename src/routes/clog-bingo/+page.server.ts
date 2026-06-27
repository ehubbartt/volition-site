import { fail, redirect } from '@sveltejs/kit';
import {
	generatePersonalBoard,
	loadPersonalBoard,
	refreshPersonalBoard,
	MIN_SIZE,
	MAX_SIZE,
	MIN_DIFFICULTY,
	MAX_DIFFICULTY
} from '$lib/server/personalBoard';
import type { Actions, PageServerLoad } from './$types';

// Per-user cooldown on the Temple collection-log fetch (generate + refresh both hit
// it). Mirrors the /me rank-check throttle — keeps us off Temple's rate limit.
const CLOG_COOLDOWN_MS = 60_000;
const lastClogFetch = new Map<string, number>();

function clogCooldownLeft(userId: string): number {
	const last = lastClogFetch.get(userId) ?? 0;
	return Math.max(0, CLOG_COOLDOWN_MS - (Date.now() - last));
}

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) throw redirect(303, '/');
	const board = await loadPersonalBoard(locals.user.id);
	return {
		rsn: locals.user.rsn,
		board,
		sizeRange: { min: MIN_SIZE, max: MAX_SIZE },
		difficultyRange: { min: MIN_DIFFICULTY, max: MAX_DIFFICULTY }
	};
};

export const actions: Actions = {
	generate: async ({ locals, request }) => {
		if (!locals.user) throw redirect(303, '/');
		if (!locals.user.rsn) {
			return fail(400, { error: 'Set your OSRS RSN on your profile first, then generate a board.' });
		}
		const wait = clogCooldownLeft(locals.user.id);
		if (wait > 0) {
			return fail(429, { error: `Please wait ${Math.ceil(wait / 1000)}s before reading your collection log again.` });
		}

		const form = await request.formData();
		const size = Number(form.get('size') ?? 5);
		const difficulty = Number(form.get('difficulty') ?? 5);

		lastClogFetch.set(locals.user.id, Date.now());
		const result = await generatePersonalBoard(locals.user.id, locals.user.rsn, size, difficulty);

		if (!result.ok) {
			// Let them retry a transient clog failure immediately.
			if (result.reason === 'clog_unavailable') lastClogFetch.delete(locals.user.id);
			const msg =
				result.reason === 'no_rsn'
					? 'Set your OSRS RSN on your profile first.'
					: result.reason === 'too_few'
						? `You're only missing ${result.missing} eligible PVM clog items — not enough for a ${Math.sqrt(result.need ?? 0)}×${Math.sqrt(result.need ?? 0)} board. Nice log! Try a smaller grid.`
						: "Couldn't read your collection log from TempleOSRS. Make sure your RSN is synced on Temple and try again.";
			return fail(result.reason === 'too_few' ? 400 : 502, { error: msg });
		}
		return { ok: true, generated: true };
	},

	refresh: async ({ locals }) => {
		if (!locals.user) throw redirect(303, '/');
		const wait = clogCooldownLeft(locals.user.id);
		if (wait > 0) {
			return fail(429, { error: `Please wait ${Math.ceil(wait / 1000)}s before checking your collection log again.` });
		}
		lastClogFetch.set(locals.user.id, Date.now());
		const result = await refreshPersonalBoard(locals.user.id);
		if (!result.ok) {
			lastClogFetch.delete(locals.user.id);
			const msg =
				result.reason === 'no_board'
					? 'No board to refresh — generate one first.'
					: "Couldn't read your collection log from TempleOSRS right now. Try again shortly.";
			return fail(502, { error: msg });
		}
		return {
			ok: true,
			refreshed: true,
			newlyObtained: result.newlyObtained,
			totalObtained: result.totalObtained
		};
	}
};
