import { redirect, error, fail } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { isAdmin } from '$lib/server/auth';
import { evaluateDinkDrop, simulateDinkDrop, type DropVerdict } from '$lib/server/dinkDrops';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) throw redirect(303, '/');
	if (!isAdmin(locals.user)) throw error(403, 'Not allowed');

	const [eventsRes, trackedRes] = await Promise.all([
		db().from('vs_events').select('id, slug, name, status, starts_at').order('created_at', { ascending: false }),
		db().from('vs_event_tracked_items').select('event_id, tile_id, item_id, item_name, source_name')
	]);

	const trackedByEvent: Record<string, { tile_id: string; item_id: number | null; item_name: string; source_name: string | null }[]> = {};
	for (const t of (trackedRes.data ?? []) as { event_id: string; tile_id: string; item_id: number | null; item_name: string; source_name: string | null }[]) {
		(trackedByEvent[t.event_id] ??= []).push(t);
	}

	return {
		events: (eventsRes.data ?? []) as { id: string; slug: string; name: string; status: string; starts_at: string | null }[],
		trackedByEvent,
		myRsn: locals.user.rsn ?? ''
	};
};

function parseInput(form: FormData) {
	const itemIdRaw = form.get('item_id')?.toString().trim();
	const receivedRaw = form.get('received_at')?.toString().trim();
	return {
		event_id: form.get('event_id')?.toString() ?? '',
		rsn: form.get('rsn')?.toString().trim() ?? '',
		item_id: itemIdRaw ? Math.floor(Number(itemIdRaw)) || null : null,
		item_name: form.get('item_name')?.toString().trim() || null,
		source: form.get('source')?.toString().trim() || null,
		received_at: receivedRaw ? new Date(receivedRaw).toISOString() : new Date().toISOString()
	};
}

export const actions: Actions = {
	dryRun: async ({ locals, request }) => {
		if (!locals.user || !isAdmin(locals.user)) throw error(403, 'Not allowed');
		const input = parseInput(await request.formData());
		if (!input.event_id) return fail(400, { error: 'Pick an event' });
		if (!input.rsn) return fail(400, { error: 'Enter an RSN' });
		if (input.item_id == null && !input.item_name) return fail(400, { error: 'Enter an item id or name' });
		const verdict = await evaluateDinkDrop(input);
		return { mode: 'dry' as const, verdict, input };
	},

	simulate: async ({ locals, request }) => {
		if (!locals.user || !isAdmin(locals.user)) throw error(403, 'Not allowed');
		const input = parseInput(await request.formData());
		if (!input.event_id) return fail(400, { error: 'Pick an event' });
		if (!input.rsn) return fail(400, { error: 'Enter an RSN' });
		if (input.item_id == null && !input.item_name) return fail(400, { error: 'Enter an item id or name' });
		// Preview the verdict first so the UI can explain the outcome…
		const verdict: DropVerdict = await evaluateDinkDrop(input);
		// …then run the real pipeline (insert vs_dink_drops + processDinkDrops).
		const result = await simulateDinkDrop(input);
		return { mode: 'sim' as const, verdict, result, input };
	}
};
