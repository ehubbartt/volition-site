import { redirect, error, fail } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { isAdmin } from '$lib/server/auth';
import { evaluateDinkDrop, evaluatePersonalDink, simulateDinkDrop, type DropVerdict } from '$lib/server/dinkDrops';

// Sentinel event_id for "target the player's personal collection-log board" instead of an event.
const PERSONAL = '__personal__';
import { listActiveTokens, revokeTokensFor } from '$lib/server/dinkTokens';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) throw redirect(303, '/');
	if (!isAdmin(locals.user)) throw error(403, 'Not allowed');

	const [eventsRes, trackedRes, tokens] = await Promise.all([
		db().from('vs_events').select('id, slug, name, status, starts_at').neq('kind', 'personal').order('created_at', { ascending: false }),
		db().from('vs_event_tracked_items').select('event_id, tile_id, item_id, item_name, source_name'),
		listActiveTokens()
	]);

	const trackedByEvent: Record<string, { tile_id: string; item_id: number | null; item_name: string; source_name: string | null }[]> = {};
	for (const t of (trackedRes.data ?? []) as { event_id: string; tile_id: string; item_id: number | null; item_name: string; source_name: string | null }[]) {
		(trackedByEvent[t.event_id] ??= []).push(t);
	}

	return {
		events: (eventsRes.data ?? []) as { id: string; slug: string; name: string; status: string; starts_at: string | null }[],
		trackedByEvent,
		tokens,
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
		notif_type: form.get('notif_type')?.toString().trim() || 'loot',
		received_at: receivedRaw ? new Date(receivedRaw).toISOString() : new Date().toISOString()
	};
}

export const actions: Actions = {
	// Admin "take it away": revoke every active Dink token for a user (by Discord id).
	// The proxy stops honouring the link within its token-cache TTL.
	revokeToken: async ({ locals, request }) => {
		if (!locals.user || !isAdmin(locals.user)) throw error(403, 'Not allowed');
		const discordId = (await request.formData()).get('discord_id')?.toString().trim();
		if (!discordId) return fail(400, { error: 'Missing discord_id' });
		try {
			await revokeTokensFor(discordId);
			return { mode: 'revoke' as const, ok: true };
		} catch (e) {
			return fail(500, { error: e instanceof Error ? e.message : 'Revoke failed' });
		}
	},

	dryRun: async ({ locals, request }) => {
		if (!locals.user || !isAdmin(locals.user)) throw error(403, 'Not allowed');
		const input = parseInput(await request.formData());
		if (!input.rsn) return fail(400, { error: 'Enter an RSN' });
		if (input.item_id == null && !input.item_name) return fail(400, { error: 'Enter an item id or name' });
		if (input.event_id === PERSONAL) {
			const verdict = await evaluatePersonalDink(input);
			return { mode: 'dry' as const, verdict, input, personal: true };
		}
		if (!input.event_id) return fail(400, { error: 'Pick an event or the personal board' });
		const verdict = await evaluateDinkDrop(input);
		return { mode: 'dry' as const, verdict, input, personal: false };
	},

	simulate: async ({ locals, request }) => {
		if (!locals.user || !isAdmin(locals.user)) throw error(403, 'Not allowed');
		const input = parseInput(await request.formData());
		if (!input.rsn) return fail(400, { error: 'Enter an RSN' });
		if (input.item_id == null && !input.item_name) return fail(400, { error: 'Enter an item id or name' });
		if (input.event_id === PERSONAL) {
			// Personal board: a clog unlock = COLLECTION notif, no event. Preview the verdict,
			// then run the real pipeline with event_id=null + notif_type='collection'.
			const verdict = await evaluatePersonalDink(input);
			const result = await simulateDinkDrop({ ...input, event_id: null, source: null, notif_type: 'collection' });
			return { mode: 'sim' as const, verdict, result, input, personal: true };
		}
		if (!input.event_id) return fail(400, { error: 'Pick an event or the personal board' });
		// Preview the verdict first so the UI can explain the outcome…
		const verdict: DropVerdict = await evaluateDinkDrop(input);
		// …then run the real pipeline (insert vs_dink_drops + processDinkDrops).
		const result = await simulateDinkDrop(input);
		return { mode: 'sim' as const, verdict, result, input, personal: false };
	}
};
