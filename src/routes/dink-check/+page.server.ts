import { redirect } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import type { PageServerLoad } from './$types';

// Player-facing Dink self-test. Confirms a member's RuneLite → Dink → proxy → Supabase
// pipeline is working WITHOUT needing a real event open: they check this page, go get any
// tracked item (the admin "Dink Self-Test" event tracks trivial drops like Bones), and if
// the drop lands in vs_dink_drops for their RSN it shows up here. Reusable for real events
// too — it lists every recent matched drop for the logged-in player's RSN.

const WINDOW_MS = 90 * 60 * 1000; // show drops from the last 90 minutes
const SELF_TEST_SLUG = 'dink-self-test';

interface DropRow {
	id: number;
	event_id: string | null;
	item_id: number | null;
	item_name: string | null;
	quantity: number;
	source: string | null;
	received_at: string;
}

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) throw redirect(303, '/');
	if (!locals.user.rsn) {
		// No RSN linked → nothing to match drops against; send them to finish onboarding.
		throw redirect(303, '/onboarding');
	}
	const rsn = locals.user.rsn;
	const since = new Date(Date.now() - WINDOW_MS).toISOString();

	const { data: dropsRaw } = await db()
		.from('vs_dink_drops')
		.select('id, event_id, item_id, item_name, quantity, source, received_at')
		.ilike('rsn', rsn)
		.gte('received_at', since)
		.order('received_at', { ascending: false })
		.limit(50);
	const drops = (dropsRaw ?? []) as DropRow[];

	// Resolve event names for any matched drops, plus whether the self-test event exists.
	const eventIds = [...new Set(drops.map((d) => d.event_id).filter((e): e is string => !!e))];
	const eventNameById = new Map<string, string>();
	if (eventIds.length) {
		const { data: evs } = await db().from('vs_events').select('id, name').in('id', eventIds);
		for (const e of (evs ?? []) as { id: string; name: string }[]) eventNameById.set(e.id, e.name);
	}

	const { data: selfTest } = await db()
		.from('vs_events')
		.select('slug, status')
		.eq('slug', SELF_TEST_SLUG)
		.maybeSingle();

	return {
		rsn,
		windowMinutes: WINDOW_MS / 60000,
		selfTestReady: !!selfTest && (selfTest as { status: string }).status === 'open',
		selfTestSlug: SELF_TEST_SLUG,
		drops: drops.map((d) => ({
			id: d.id,
			item_id: d.item_id,
			item_name: d.item_name,
			quantity: d.quantity,
			source: d.source,
			received_at: d.received_at,
			event_name: d.event_id ? eventNameById.get(d.event_id) ?? null : null
		}))
	};
};
