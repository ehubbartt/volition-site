import { fail, redirect } from '@sveltejs/kit';
import {
	generatePersonalBoard,
	generateTestPersonalBoard,
	lockPersonalBoard,
	refreshPersonalBoard,
	submitPersonalTile
} from '$lib/server/personalBoard';
import { isAdmin } from '$lib/server/auth';
import type { Actions } from './$types';

// ACTIONS ONLY — this page has no server load. Its data comes from
// /api/personal-board (built in $lib/server/personalBoardPage.ts) via the
// universal load in +page.ts, so navigating here never waits on the server.

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

	// TEMPORARY (admin-only): generate the easiest possible 3x3 board — cheapest missing
	// clog items, 1 XP skill goals, easiest uncompleted CAs — for end-to-end testing of
	// Dink collection / XP / CA tracking. Remove once tracking is verified in prod.
	generateTest: async ({ locals }) => {
		if (!locals.user) throw redirect(303, '/');
		if (!isAdmin(locals.user)) return fail(403, { error: 'Admins only.' });

		const result = await generateTestPersonalBoard(locals.user.id, locals.user.rsn);
		if (!result.ok) {
			const msg =
				result.reason === 'no_rsn'
					? 'Set your OSRS RSN on your profile first.'
					: result.reason === 'locked'
						? `Your board is locked in until ${result.resettable_at ? fmtResetDate(result.resettable_at) : 'later'}. You can make a new one after that.`
						: result.reason === 'ca_unavailable'
							? "Couldn't read your combat achievements from WikiSync. Make sure your RSN is synced in RuneLite's WikiSync plugin and try again."
							: result.reason === 'too_few'
								? `You're only missing ${result.missing} eligible clog items — not enough to fill the test board (needs ${result.need}).`
								: "Couldn't read your collection log from TempleOSRS. Make sure your RSN is synced on Temple and try again.";
			const status = result.reason === 'too_few' ? 400 : result.reason === 'locked' ? 403 : 502;
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
	},

	// Manually mark a tile done (owner-attested), with optional proof screenshots.
	submitTile: async ({ locals, request }) => {
		if (!locals.user) throw redirect(303, '/');
		const form = await request.formData();
		const idx = Math.floor(Number(form.get('tile_id')));
		if (!Number.isFinite(idx)) return fail(400, { error: 'Unknown tile' });
		const files = form.getAll('proof').filter((f): f is File => f instanceof File && f.size > 0);

		const result = await submitPersonalTile(locals.user.id, idx, files);
		if (!result.ok) {
			const msg =
				result.reason === 'no_board'
					? 'No board to submit to — generate one first.'
					: result.reason === 'not_locked'
						? 'Lock your board in first — drafts aren’t tracked until you commit to them.'
						: result.reason === 'no_tile'
							? 'That tile is no longer on your board.'
							: result.reason === 'already_pending'
								? 'This tile already has a submission awaiting admin review.'
								: (result.error ?? "Couldn't save your submission. Try again shortly.");
			return fail(
				result.reason === 'not_locked' || result.reason === 'already_pending' ? 400 : result.reason === 'no_tile' ? 404 : 502,
				{ error: msg }
			);
		}
		return { ok: true, submitted: true };
	}
};
