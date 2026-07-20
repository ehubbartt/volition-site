import { redirect, fail } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { rsnExactPattern } from '$lib/server/users';
import {
	getOrCreateToken,
	rotateToken,
	configUrlFor,
	getMultiServer,
	setMultiServer
} from '$lib/server/dinkTokens';
import { pinSelfTest, clearSelfTestPin } from '$lib/server/dinkAllowlist';
import type { Actions, PageServerLoad } from './$types';

// Player-facing Dink self-test. Confirms a member's RuneLite → Dink → proxy → Supabase
// pipeline is working WITHOUT needing a real event open: opening this page PINS Bones to the
// member's tracked-item allowlist (via dinkAllowlist.pinSelfTest — a short, self-expiring
// manual pin, not a fake event), they go kill anything that drops Bones, and when the drop
// lands in vs_dink_drops for their RSN it shows up here. A verifying Bones drop clears the
// pin (test proven); the pin otherwise expires on its own. Also lists every recent matched
// drop for the logged-in player's RSN, so it's reusable for real events too.

const WINDOW_MS = 90 * 60 * 1000; // show drops from the last 90 minutes
const BONES_ID = 526;

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
		.ilike('rsn', rsnExactPattern(rsn))
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

	// Zero-friction self-test via a self-expiring manual pin (no fake event, no signup, no
	// prune job): opening this page PINS Bones to the member's tracked-item allowlist so their
	// Bones drops reach the tracker while they're testing. A recent verifying Bones drop clears
	// the pin (pipeline proven — re-visiting re-pins, so re-testing always works); otherwise the
	// pin expires on its own (SELF_TEST_TTL_MS in dinkAllowlist). Both writes swallow + log.
	const bonesSeen = drops.some(
		(d) => d.item_id === BONES_ID || d.item_name?.toLowerCase() === 'bones'
	);
	if (bonesSeen) await clearSelfTestPin(locals.user.id);
	else await pinSelfTest(locals.user.id);

	// The player's personal Dink config URL (mint one on first visit). Same token the
	// Discord /dink command would hand out — keyed by Discord id.
	let configUrl: string | null = null;
	let proxyConfigured = true;
	let multiServer = false;
	try {
		const { token } = await getOrCreateToken(locals.user.discord_id);
		configUrl = configUrlFor(token);
		proxyConfigured = configUrl !== null;
		multiServer = await getMultiServer(locals.user.discord_id);
	} catch (e) {
		console.warn('[dink-check] token mint failed:', e instanceof Error ? e.message : e);
		proxyConfigured = false;
	}

	return {
		rsn,
		configUrl,
		proxyConfigured,
		multiServer,
		windowMinutes: WINDOW_MS / 60000,
		// The self-test is available whenever the member has a config URL to test with — the
		// pin mechanism itself is always on (no event to be open/closed).
		selfTestReady: proxyConfigured,
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

export const actions: Actions = {
	// Rotate the player's config link — the old URL stops working within the proxy's
	// token-cache TTL. Use after a leak or just to invalidate a shared link.
	rotate: async ({ locals }) => {
		if (!locals.user) throw redirect(303, '/');
		try {
			const token = await rotateToken(locals.user.discord_id);
			return { rotated: true, configUrl: configUrlFor(token) };
		} catch (e) {
			return fail(500, { error: e instanceof Error ? e.message : 'Could not rotate token' });
		}
	},

	// Flip the member between the standard config (minLootValue 1 — zero maintenance)
	// and the multi-server config (high threshold + tracked-item whitelist — safe for
	// people whose Dink also feeds other Discord servers). Served by the proxy per
	// token; Dink picks the change up on its next config load (plugin toggle).
	setMultiServer: async ({ locals, request }) => {
		if (!locals.user) throw redirect(303, '/');
		const on = (await request.formData()).get('multi') === 'true';
		try {
			await setMultiServer(locals.user.discord_id, on);
			return { multiSaved: true, multiServer: on };
		} catch (e) {
			return fail(500, { error: e instanceof Error ? e.message : 'Could not save the setting' });
		}
	}
};
