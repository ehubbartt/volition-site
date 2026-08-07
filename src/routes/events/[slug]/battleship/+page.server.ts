import { fail } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import {
	bombClaimTarget,
	fireBomb,
	leaveEvent,
	loadBattleship,
	placeFleet
} from '$lib/server/battleship';
import { createSubmission } from '$lib/server/submissions';
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
		// Captain-only, for the same reason the fleet is captain-only to READ: anyone who
		// can write the placement knows it afterwards, and could overwrite the captain's.
		if (side.captainUserId !== locals.user.id) {
			return fail(403, { error: 'Only your captain places the fleet' });
		}

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
	},

	// Manual bomb claim, for members who can't run Dink. Goes through the normal
	// /admin/submissions review queue rather than arming anything directly — the value is
	// self-reported, so it needs a human and a screenshot behind it. Approval mints the
	// bomb (mintBombsForApprovedClaims).
	claim: async ({ locals, params, request }) => {
		if (!locals.user) return fail(401, { error: 'Sign in first' });
		const { snap, side } = await sideFor(params.slug, locals.user.id);
		if (!snap) return fail(404, { error: 'Game not found' });
		if (!side) return fail(403, { error: 'You are not on a side in this game', claim: true });
		if (snap.phase !== 'battle') return fail(400, { error: 'The battle is not running', claim: true });

		const form = await request.formData();
		const raw = form.get('value')?.toString().trim() ?? '';
		// Accept "5m" / "5,000,000" / "5000000" — people will type all three.
		const m = /^([\d.,]+)\s*([kmb])?$/i.exec(raw.replace(/\s/g, ''));
		if (!m) return fail(400, { error: 'Enter the drop value, e.g. 5m or 5000000', claim: true });
		const mult = { k: 1e3, m: 1e6, b: 1e9 }[(m[2] ?? '').toLowerCase()] ?? 1;
		const value = Math.round(Number(m[1].replace(/,/g, '')) * mult);
		if (!Number.isFinite(value) || value <= 0) return fail(400, { error: 'That value is not a number', claim: true });

		const floor = snap.config.tiers[0].min_value;
		if (value < floor) {
			return fail(400, { error: `Drops under ${(floor / 1e6).toFixed(0)}m don't arm a bomb`, claim: true });
		}

		const files = form.getAll('proof').filter((f): f is File => f instanceof File && f.size > 0);
		if (files.length === 0) return fail(400, { error: 'Attach a screenshot of the drop', claim: true });

		// One claim in the queue at a time. The value is self-reported, so the only real
		// check is a human looking at the screenshot — and someone firing off ten claims
		// for the same drop makes it far likelier one slips through on a busy queue.
		// Reviewers see them one at a time instead.
		const { data: pending } = await db()
			.from('vs_submissions')
			.select('id')
			.eq('event_id', snap.event.id)
			.eq('user_id', locals.user.id)
			.eq('status', 'pending')
			.limit(1);
		if (pending?.length) {
			return fail(400, {
				error: 'You already have a claim waiting for review — it has to be decided before you send another.',
				claim: true
			});
		}

		const label = form.get('item')?.toString().trim() || null;
		const res = await createSubmission({
			eventId: snap.event.id,
			userId: locals.user.id,
			teamId: side.teamId,
			targetId: bombClaimTarget(value),
			targetLabel: label,
			files
		});
		return res.ok
			? { ok: true, claim: true, report: 'Claim submitted — an admin will review it and your bomb will appear here.' }
			: fail(400, { error: res.error, claim: true });
	},

	leave: async ({ locals, params }) => {
		if (!locals.user) return fail(401, { error: 'Sign in first' });
		const { data: ev } = await db()
			.from('vs_events')
			.select('id')
			.eq('slug', params.slug)
			.maybeSingle();
		if (!ev) return fail(404, { error: 'Game not found' });

		// leaveEvent owns the rules (signup phase only, never once drafted).
		const res = await leaveEvent({ eventId: (ev as { id: string }).id, userId: locals.user.id });
		return res.ok ? { ok: true, left: true } : fail(400, { error: res.error });
	}
};
