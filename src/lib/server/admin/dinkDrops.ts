import { db } from '$lib/server/db';

// Admin debugging view over vs_dink_drops: every drop the proxy matched, with the
// consumer's verdict (outcome) so you can answer "why didn't I get credit?". Filter to
// non-credited rows via `show=unmatched`.

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

export async function buildDinkDrops(show: string | null) {
	const filter = show === 'unmatched' ? 'unmatched' : 'all';

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
}
