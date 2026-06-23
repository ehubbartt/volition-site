import { redirect, error, fail } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { isAdmin } from '$lib/server/auth';
import { evaluateDinkDrop, simulateDinkDrop, type DropVerdict } from '$lib/server/dinkDrops';
import { listActiveTokens, revokeTokensFor } from '$lib/server/dinkTokens';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) throw redirect(303, '/');
	if (!isAdmin(locals.user)) throw error(403, 'Not allowed');

	const [eventsRes, trackedRes, tokens] = await Promise.all([
		db().from('vs_events').select('id, slug, name, status, starts_at').order('created_at', { ascending: false }),
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
		received_at: receivedRaw ? new Date(receivedRaw).toISOString() : new Date().toISOString()
	};
}

// Cheap, easy-to-get items members can farm to verify their Dink pipeline.
const SELF_TEST_ITEMS = [
	{ name: 'Bones', id: 526 },
	{ name: 'Cowhide', id: 1739 },
	{ name: 'Feather', id: 314 },
	{ name: 'Raw chicken', id: 2138 },
	{ name: 'Big bones', id: 532 }
];
const SELF_TEST_SLUG = 'dink-self-test';

export const actions: Actions = {
	// One-click: (re)create the always-on "Dink Self-Test" event — an open bingo event
	// (start in the past so every tile is released) whose tiles track trivially-easy
	// items. Members get one, Dink routes it through the proxy, and /dink-check shows it.
	createSelfTest: async ({ locals }) => {
		if (!locals.user || !isAdmin(locals.user)) throw error(403, 'Not allowed');
		const structure = {
			rowCount: SELF_TEST_ITEMS.length,
			rowIntervalHours: 0.0001, // all rows released immediately
			bonusEnabled: false,
			tiers: [{ key: 'test', label: 'Dink check', points: 1, color: '#3aa6ff' }]
		};
		// Upsert the event by slug.
		const { data: existing } = await db().from('vs_events').select('id').eq('slug', SELF_TEST_SLUG).maybeSingle();
		let eventId = (existing as { id: string } | null)?.id ?? null;
		if (eventId) {
			await db().from('vs_events').update({ status: 'open', starts_at: new Date(Date.now() - 3600_000).toISOString(), structure }).eq('id', eventId);
			await db().from('vs_event_tiles').delete().eq('event_id', eventId);
			await db().from('vs_event_tracked_items').delete().eq('event_id', eventId);
		} else {
			const { data: ev, error: e } = await db().from('vs_events').insert({
				slug: SELF_TEST_SLUG, name: 'Dink Self-Test', kind: 'bingo', status: 'open', team_size: 1,
				starts_at: new Date(Date.now() - 3600_000).toISOString(), structure
			}).select('id').single();
			if (e || !ev) return fail(500, { error: e?.message ?? 'Could not create event' });
			eventId = ev.id;
		}
		const tiles = SELF_TEST_ITEMS.map((it, i) => ({ event_id: eventId, tile_id: `r${i + 1}-test`, row: i + 1, tier: 'test', name: it.name, points: 1 }));
		const tracked = SELF_TEST_ITEMS.map((it, i) => ({ event_id: eventId, tile_id: `r${i + 1}-test`, item_id: it.id, item_name: it.name, required_qty: 1 }));
		const { error: te } = await db().from('vs_event_tiles').insert(tiles);
		if (te) return fail(500, { error: te.message });
		const { error: tie } = await db().from('vs_event_tracked_items').insert(tracked);
		if (tie) return fail(500, { error: tie.message });
		return { mode: 'selftest' as const, ok: true, slug: SELF_TEST_SLUG, items: SELF_TEST_ITEMS.map((i) => i.name) };
	},

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
