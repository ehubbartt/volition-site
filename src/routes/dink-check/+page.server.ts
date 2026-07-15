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
import type { Actions, PageServerLoad } from './$types';

// Player-facing Dink self-test. Confirms a member's RuneLite → Dink → proxy → Supabase
// pipeline is working WITHOUT needing a real event open: they check this page, go get any
// tracked item (the admin "Dink Self-Test" event tracks trivial drops like Bones), and if
// the drop lands in vs_dink_drops for their RSN it shows up here. Reusable for real events
// too — it lists every recent matched drop for the logged-in player's RSN.

const WINDOW_MS = 90 * 60 * 1000; // show drops from the last 90 minutes
const SELF_TEST_SLUG = 'dink-self-test';
// Abandoned self-test enrollments (opened the page, never produced a verifying Bones
// drop, never came back) are pruned after this long so Bones doesn't linger in the
// member's served Dink allowlist indefinitely.
const SELF_TEST_ENROLL_TTL_MS = 24 * 60 * 60 * 1000;
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

	const { data: selfTest } = await db()
		.from('vs_events')
		.select('id, slug, status')
		.eq('slug', SELF_TEST_SLUG)
		.maybeSingle();

	// Zero-friction self-test, scoped to when it's actually NEEDED: opening this page
	// IS the signup (a bare signup row is all vs_active_player_tiles needs to make the
	// self-test item tracked for this player), but the enrollment isn't permanent —
	// Bones should only sit in the member's served Dink allowlist while they're
	// testing. So: a recent verifying Bones drop UN-enrolls them (pipeline proven —
	// re-visiting after the window re-enrolls, so re-testing always works), a visit
	// without one enrolls/refreshes the signup, and enrollments with no visit inside
	// SELF_TEST_ENROLL_TTL_MS are pruned as abandoned.
	if (selfTest && (selfTest as { status: string }).status === 'open') {
		const eventId = (selfTest as { id: string }).id;
		const bonesSeen = drops.some(
			(d) => d.item_id === BONES_ID || d.item_name?.toLowerCase() === 'bones'
		);
		if (bonesSeen) {
			await db().from('vs_event_signups').delete().eq('event_id', eventId).eq('user_id', locals.user.id);
		} else {
			const now = new Date().toISOString();
			const { data: refreshed } = await db()
				.from('vs_event_signups')
				.update({ joined_at: now })
				.eq('event_id', eventId)
				.eq('user_id', locals.user.id)
				.select('id');
			if (!refreshed?.length) {
				const { error: enrollErr } = await db()
					.from('vs_event_signups')
					.insert({ event_id: eventId, user_id: locals.user.id, joined_at: now });
				if (enrollErr && !enrollErr.message.includes('duplicate')) {
					console.warn('[dink-check] self-test enroll failed:', enrollErr.message);
				}
			}
		}
		// Prune everyone's abandoned enrollments (self-test event only) — lazy, on page
		// visits, which is plenty: a stale row is harmless beyond allowlist noise.
		await db()
			.from('vs_event_signups')
			.delete()
			.eq('event_id', eventId)
			.lt('joined_at', new Date(Date.now() - SELF_TEST_ENROLL_TTL_MS).toISOString());
	}

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
