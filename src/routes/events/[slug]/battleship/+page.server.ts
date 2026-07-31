import { fail } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { fireBomb, loadBattleship, placeFleet } from '$lib/server/battleship';
import type { Actions } from './$types';

// ACTIONS ONLY — the page has no server load. Its data comes from
// /api/battleship/[slug] via the universal load in +page.ts (docs/PAGES.md).
//
// Both actions re-derive the caller's side from the database rather than trusting a
// form field: a member may only place their OWN fleet and may only fire their own
// side's bombs, and nothing in the request is allowed to say otherwise.

async function sideFor(slug: string, userId: string) {
	const snap = await loadBattleship(slug);
	if (!snap) return { snap: null, side: null } as const;
	const side = snap.sides.find((s) => s.members.some((m) => m.userId === userId)) ?? null;
	return { snap, side } as const;
}

export const actions: Actions = {
	place: async ({ locals, params, request }) => {
		if (!locals.user) return fail(401, { error: 'Sign in first' });
		const { snap, side } = await sideFor(params.slug, locals.user.id);
		if (!snap) return fail(404, { error: 'Game not found' });
		if (!side) return fail(403, { error: 'You are not on a side in this game' });

		const form = await request.formData();
		let fleet: unknown;
		try {
			fleet = JSON.parse(form.get('fleet')?.toString() ?? '[]');
		} catch {
			return fail(400, { error: 'Could not read that placement' });
		}
		if (!Array.isArray(fleet)) return fail(400, { error: 'Could not read that placement' });

		// placeFleet re-validates every ship against the board — this is not a trusted path.
		const res = await placeFleet({ eventId: snap.event.id, side: side.side, fleet: fleet as never });
		return res.ok ? { ok: true, placed: true } : fail(400, { error: res.error });
	},

	fire: async ({ locals, params, request }) => {
		if (!locals.user) return fail(401, { error: 'Sign in first' });
		const { snap, side } = await sideFor(params.slug, locals.user.id);
		if (!snap) return fail(404, { error: 'Game not found' });
		if (!side) return fail(403, { error: 'You are not on a side in this game' });

		const form = await request.formData();
		const x = Number(form.get('x'));
		const y = Number(form.get('y'));
		if (!Number.isInteger(x) || !Number.isInteger(y)) return fail(400, { error: 'Pick a target square' });

		const res = await fireBomb({
			eventId: snap.event.id,
			arsenalId: form.get('arsenal_id')?.toString() ?? '',
			byUserId: locals.user.id,
			anchor: { x, y }
			// No `force`: the store enforces "your side, and your bomb unless you're captain".
		});
		if (!res.ok) return fail(400, { error: res.error });

		const r = res.value!;
		const parts = [r.hits ? `${r.hits} hit${r.hits === 1 ? '' : 's'}!` : 'Miss.'];
		if (r.sunk.length) parts.push(`You sank their ${r.sunk.map((s) => s.name).join(' and ')}!`);
		if (r.skipped.length) parts.push(`${r.skipped.length} square${r.skipped.length === 1 ? '' : 's'} were already hit.`);
		if (r.defeated) parts.push('Their whole fleet is destroyed — you win!');
		return { ok: true, report: parts.join(' ') };
	},

	join: async ({ locals, params }) => {
		if (!locals.user) return fail(401, { error: 'Sign in first' });
		const sb = db();
		const { data: ev } = await sb
			.from('vs_events')
			.select('id, status, signup_opens_at, signup_closes_at, structure')
			.eq('slug', params.slug)
			.maybeSingle();
		if (!ev) return fail(404, { error: 'Game not found' });

		const e = ev as {
			id: string; status: string; signup_opens_at: string | null; signup_closes_at: string | null;
			structure: { battleship?: { phase?: string } } | null;
		};
		if (e.status !== 'open') return fail(400, { error: 'This event is not open' });
		if ((e.structure?.battleship?.phase ?? '') !== 'signup') return fail(400, { error: 'Signups have closed' });
		if (e.signup_opens_at && new Date(e.signup_opens_at) > new Date()) {
			return fail(400, { error: 'Signups have not opened yet' });
		}
		if (e.signup_closes_at && new Date(e.signup_closes_at) < new Date()) {
			return fail(400, { error: 'Signups have closed' });
		}

		const { data: existing } = await sb
			.from('vs_event_signups')
			.select('id')
			.eq('event_id', e.id)
			.eq('user_id', locals.user.id)
			.maybeSingle();
		if (existing) return { ok: true };

		const { error: insErr } = await sb
			.from('vs_event_signups')
			.insert({ event_id: e.id, user_id: locals.user.id });
		return insErr ? fail(400, { error: insErr.message }) : { ok: true };
	}
};
