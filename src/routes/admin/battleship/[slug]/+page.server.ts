import { redirect, fail, error } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { isAdmin } from '$lib/server/auth';
import {
	autoDraftRemaining,
	draftPick,
	fireBomb,
	grantBomb,
	loadBattleship,
	maybeAdvancePhase,
	openPlacement,
	placeFleet,
	startBattle,
	startDraft
} from '$lib/server/battleship';
import { autoPlace } from '$lib/battleship/rules';
import type { Actions, PageServerLoad } from './$types';

// The tester: one admin drives every side of a game by hand, the same way
// /admin/catan does. Every action here goes through the same server module a
// player's action does — the only difference is `force`, which skips the
// "is it your turn / is it your bomb" checks so one person can play both sides.

export const load: PageServerLoad = async ({ locals, params }) => {
	if (!locals.user) throw redirect(303, '/');
	if (!isAdmin(locals.user)) throw redirect(303, '/');

	let snap = await loadBattleship(params.slug);
	if (!snap) throw error(404, 'No Battleship game with that slug');

	// Poll-on-read: the placement deadline opens the battle without a scheduler.
	if (await maybeAdvancePhase(snap)) snap = (await loadBattleship(params.slug)) ?? snap;

	// The tester is the one view that legitimately sees both fleets.
	return { game: snap };
};

function requireAdmin(locals: App.Locals) {
	if (!locals.user || !isAdmin(locals.user)) return fail(403, { error: 'Admins only' });
	return null;
}

async function eventIdFor(slug: string): Promise<string | null> {
	const { data } = await db().from('vs_events').select('id').eq('slug', slug).maybeSingle();
	return (data as { id: string } | null)?.id ?? null;
}

export const actions: Actions = {
	// Bulk-enrol members so a test game has a pool to draft without waiting for signups.
	seed: async ({ locals, params, request }) => {
		const denied = requireAdmin(locals);
		if (denied) return denied;
		const eventId = await eventIdFor(params.slug);
		if (!eventId) return fail(404, { error: 'Game not found' });

		const form = await request.formData();
		const count = Math.max(2, Math.min(200, Number(form.get('count')) || 32));

		const sb = db();
		const { data: users } = await sb.from('vs_users').select('id').not('rsn', 'is', null).limit(count * 2);
		// Put the admin doing the seeding in the game first, so they can drive the player
		// view as an actual participant rather than a spectator.
		const ids = [
			locals.user!.id,
			...((users ?? []) as { id: string }[]).map((u) => u.id).filter((id) => id !== locals.user!.id)
		];
		if (ids.length < 2) return fail(400, { error: 'Not enough members with an RSN on the roster' });

		const { data: already } = await sb.from('vs_event_signups').select('user_id').eq('event_id', eventId);
		const have = new Set(((already ?? []) as { user_id: string }[]).map((s) => s.user_id));
		const rows = ids.filter((id) => !have.has(id)).slice(0, count - have.size).map((user_id) => ({ event_id: eventId, user_id }));
		if (!rows.length) return { ok: true };

		const { error: insErr } = await sb.from('vs_event_signups').insert(rows);
		return insErr ? fail(400, { error: insErr.message }) : { ok: true };
	},

	startDraft: async ({ locals, params, request }) => {
		const denied = requireAdmin(locals);
		if (denied) return denied;
		const eventId = await eventIdFor(params.slug);
		if (!eventId) return fail(404, { error: 'Game not found' });

		const form = await request.formData();
		const c1 = form.get('captain1')?.toString() ?? '';
		const c2 = form.get('captain2')?.toString() ?? '';
		const n1 = form.get('name1')?.toString().trim() || 'Fleet Red';
		const n2 = form.get('name2')?.toString().trim() || 'Fleet Blue';

		const res = await startDraft({ eventId, captains: [c1, c2], names: [n1, n2] });
		return res.ok ? { ok: true } : fail(400, { error: res.error });
	},

	pick: async ({ locals, params, request }) => {
		const denied = requireAdmin(locals);
		if (denied) return denied;
		const eventId = await eventIdFor(params.slug);
		if (!eventId) return fail(404, { error: 'Game not found' });

		const form = await request.formData();
		const res = await draftPick({
			eventId,
			side: Number(form.get('side')),
			userId: form.get('user_id')?.toString() ?? '',
			force: form.get('force') === 'on'
		});
		// The pick report rides back so the page can announce it (see the draft modal).
		return res.ok ? { ok: true, pick: res.value } : fail(400, { error: res.error });
	},

	// Fill the rest of the draft in one go — the tester's time-saver, alternating
	// sides exactly as the real draft would.
	autoDraft: async ({ locals, params }) => {
		const denied = requireAdmin(locals);
		if (denied) return denied;
		const eventId = await eventIdFor(params.slug);
		if (!eventId) return fail(404, { error: 'Game not found' });

		const res = await autoDraftRemaining(eventId);
		return res.ok ? { ok: true } : fail(400, { error: res.error });
	},

	autoPlace: async ({ locals, params, request }) => {
		const denied = requireAdmin(locals);
		if (denied) return denied;
		const eventId = await eventIdFor(params.slug);
		if (!eventId) return fail(404, { error: 'Game not found' });

		const snap = await loadBattleship(params.slug);
		if (!snap) return fail(404, { error: 'Game not found' });
		const form = await request.formData();
		const side = Number(form.get('side'));

		const res = await placeFleet({ eventId, side, fleet: autoPlace(snap.config.size) });
		return res.ok ? { ok: true } : fail(400, { error: res.error });
	},

	openPlacement: async ({ locals, params }) => {
		const denied = requireAdmin(locals);
		if (denied) return denied;
		const eventId = await eventIdFor(params.slug);
		if (!eventId) return fail(404, { error: 'Game not found' });
		const res = await openPlacement(eventId);
		return res.ok ? { ok: true } : fail(400, { error: res.error });
	},

	startBattle: async ({ locals, params }) => {
		const denied = requireAdmin(locals);
		if (denied) return denied;
		const eventId = await eventIdFor(params.slug);
		if (!eventId) return fail(404, { error: 'Game not found' });
		const res = await startBattle(eventId);
		return res.ok ? { ok: true } : fail(400, { error: res.error });
	},

	grant: async ({ locals, params, request }) => {
		const denied = requireAdmin(locals);
		if (denied) return denied;
		const eventId = await eventIdFor(params.slug);
		if (!eventId) return fail(404, { error: 'Game not found' });

		const form = await request.formData();
		const res = await grantBomb({
			eventId,
			side: Number(form.get('side')),
			tier: Number(form.get('tier')),
			note: 'Tester grant'
		});
		return res.ok ? { ok: true } : fail(400, { error: res.error });
	},

	fire: async ({ locals, params, request }) => {
		const denied = requireAdmin(locals);
		if (denied) return denied;
		const eventId = await eventIdFor(params.slug);
		if (!eventId) return fail(404, { error: 'Game not found' });

		const form = await request.formData();
		const res = await fireBomb({
			eventId,
			arsenalId: form.get('arsenal_id')?.toString() ?? '',
			byUserId: locals.user!.id,
			anchor: { x: Number(form.get('x')), y: Number(form.get('y')) },
			force: true
		});
		if (!res.ok) return fail(400, { error: res.error });
		const r = res.value!;
		const parts = [`${r.hits} hit${r.hits === 1 ? '' : 's'}`];
		if (r.sunk.length) parts.push(`sank ${r.sunk.map((s) => s.name).join(', ')}`);
		if (r.skipped.length) parts.push(`${r.skipped.length} already cratered`);
		if (r.defeated) parts.push('FLEET DESTROYED');
		return { ok: true, report: parts.join(' · ') };
	}
};
