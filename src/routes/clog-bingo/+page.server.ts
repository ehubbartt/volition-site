import { fail, redirect } from '@sveltejs/kit';
import {
	generatePersonalBoard,
	lockPersonalBoard,
	loadPersonalBoard,
	refreshPersonalBoard,
	boardResettableAt,
	LOCK_DAYS,
	MIN_SIZE,
	MAX_SIZE,
	MIN_DIFFICULTY,
	MAX_DIFFICULTY
} from '$lib/server/personalBoard';
import type { Actions, PageServerLoad } from './$types';

function fmtResetDate(iso: string): string {
	try {
		return new Date(iso).toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' });
	} catch {
		return iso;
	}
}

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
	const resettableAt = board?.locked_at ? boardResettableAt(board.locked_at) : null;
	const canReset = !board || !board.locked_at || (resettableAt != null && Date.now() >= new Date(resettableAt).getTime());
	return {
		rsn: locals.user.rsn,
		board,
		locked: !!board?.locked_at,
		resettableAt,
		canReset,
		lockDays: LOCK_DAYS,
		sizeRange: { min: MIN_SIZE, max: MAX_SIZE },
		difficultyRange: { min: MIN_DIFFICULTY, max: MAX_DIFFICULTY }
	};
};

export const actions: Actions = {
	// Generate / reroll a DRAFT board. Free to repeat (the owned-clog set is cached in
	// personalBoard, so rerolls reshuffle without hammering Temple); refused while a board
	// is locked and inside its commitment window.
	generate: async ({ locals, request }) => {
		if (!locals.user) throw redirect(303, '/');
		if (!locals.user.rsn) {
			return fail(400, { error: 'Set your OSRS RSN on your profile first, then generate a board.' });
		}

		const form = await request.formData();
		const size = Number(form.get('size') ?? 5);
		const difficulty = Number(form.get('difficulty') ?? 5);
		const skilling = form.get('skilling') === 'on' || form.get('skilling') === 'true';
		const ca = form.get('ca') === 'on' || form.get('ca') === 'true';
		// "Include pets" is a checkbox — absent from the form data means unchecked (exclude pets).
		const pets = form.get('pets') === 'on' || form.get('pets') === 'true';
		// Skilling sub-option: skip skills the player has already 99'd.
		const skip99 = form.get('skip99') === 'on' || form.get('skip99') === 'true';

		const result = await generatePersonalBoard(locals.user.id, locals.user.rsn, size, difficulty, skilling, ca, pets, skip99);

		if (!result.ok) {
			const msg =
				result.reason === 'no_rsn'
					? 'Set your OSRS RSN on your profile first.'
					: result.reason === 'locked'
						? `Your board is locked in until ${result.resettable_at ? fmtResetDate(result.resettable_at) : 'later'}. You can make a new one after that.`
						: result.reason === 'ca_unavailable'
							? "Couldn't read your combat achievements from WikiSync. Make sure your RSN is synced in RuneLite's WikiSync plugin and try again, or turn off combat achievements."
							: result.reason === 'too_few'
								? `You're only missing ${result.missing} eligible PVM clog items — not enough to fill this board (needs ${result.need}). Nice log! Try a smaller grid${skilling && ca && pets ? '' : ', or enable more options (skilling, combat achievements, pets)'}.`
								: "Couldn't read your collection log from TempleOSRS. Make sure your RSN is synced on Temple and try again.";
			const status =
				result.reason === 'too_few' ? 400 : result.reason === 'locked' ? 403 : 502;
			return fail(status, { error: msg });
		}
		return { ok: true, generated: true };
	},

	// Lock the current draft in: starts tracking + the commitment window.
	lock: async ({ locals }) => {
		if (!locals.user) throw redirect(303, '/');
		const res = await lockPersonalBoard(locals.user.id);
		if (!res.ok) return fail(400, { error: 'No board to lock — generate one first.' });
		return { ok: true, locked: true };
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
					: result.reason === 'not_locked'
						? 'Lock your board in first — drafts aren’t tracked until you commit to them.'
						: "Couldn't read your collection log from TempleOSRS right now. Try again shortly.";
			return fail(result.reason === 'not_locked' ? 400 : 502, { error: msg });
		}
		return {
			ok: true,
			refreshed: true,
			newlyObtained: result.newlyObtained,
			totalObtained: result.totalObtained
		};
	}
};
