import { redirect, error, fail } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { isAdmin } from '$lib/server/auth';
import { revertDinkCredit, reprocessDinkDrop } from '$lib/server/dinkDrops';
import type { Actions, PageServerLoad } from './$types';

// Admin debugging view over vs_dink_drops: every drop the proxy matched, with the
// consumer's verdict (outcome) so you can answer "why didn't I get credit?". Filter to
// non-credited rows, and reverse a wrong credit or re-run a drop.

interface DropRow {
	id: number;
	event_id: string | null;
	rsn: string;
	item_id: number | null;
	item_name: string | null;
	quantity: number;
	source: string | null;
	notif_type: string;
	value: number | null;
	outcome: string | null;
	received_at: string;
}

export const load: PageServerLoad = async ({ locals, url }) => {
	if (!locals.user) throw redirect(303, '/');
	if (!isAdmin(locals.user)) throw error(403, 'Not allowed');

	const filter = url.searchParams.get('show') === 'unmatched' ? 'unmatched' : 'all';

	let q = db()
		.from('vs_dink_drops')
		.select('id, event_id, rsn, item_id, item_name, quantity, source, notif_type, value, outcome, received_at')
		.order('received_at', { ascending: false })
		.limit(250);
	// "unmatched" = anything that didn't credit (incl. not-yet-processed null outcomes).
	if (filter === 'unmatched') q = q.or('outcome.is.null,outcome.neq.credited');

	const { data: dropsRaw, error: e } = await q;
	const drops = (dropsRaw ?? []) as DropRow[];

	const eventIds = [...new Set(drops.map((d) => d.event_id).filter((x): x is string => !!x))];
	const eventById = new Map<string, { name: string; slug: string }>();
	if (eventIds.length) {
		const { data: evs } = await db().from('vs_events').select('id, name, slug').in('id', eventIds);
		for (const ev of (evs ?? []) as { id: string; name: string; slug: string }[]) {
			eventById.set(ev.id, { name: ev.name, slug: ev.slug });
		}
	}

	return {
		filter,
		loadError: e?.message ?? null,
		drops: drops.map((d) => ({
			...d,
			event_name: d.event_id ? eventById.get(d.event_id)?.name ?? null : null,
			event_slug: d.event_id ? eventById.get(d.event_id)?.slug ?? null : null
		}))
	};
};

export const actions: Actions = {
	uncredit: async ({ locals, request }) => {
		if (!locals.user || !isAdmin(locals.user)) throw error(403, 'Not allowed');
		const id = Number((await request.formData()).get('id'));
		if (!Number.isFinite(id)) return fail(400, { error: 'Bad id' });
		const res = await revertDinkCredit(id);
		return res.ok ? { ok: true, msg: 'Credit reverted.' } : fail(400, { error: res.error });
	},
	reprocess: async ({ locals, request }) => {
		if (!locals.user || !isAdmin(locals.user)) throw error(403, 'Not allowed');
		const id = Number((await request.formData()).get('id'));
		if (!Number.isFinite(id)) return fail(400, { error: 'Bad id' });
		const res = await reprocessDinkDrop(id);
		return res.error
			? fail(400, { error: res.error })
			: { ok: true, msg: `Reprocessed — credited ${res.credited}.` };
	}
};
