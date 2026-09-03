import { redirect, fail, error } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { isAdmin } from '$lib/server/auth';
import { logAudit } from '$lib/server/audit';
import { fetchAllFiltered } from '$lib/server/db';
import {
	addCustomTile,
	assignSides,
	claimTile,
	creditManual,
	enrolMembers,
	finishGame,
	loadConnect4,
	removeCustomTile,
	setPoolOptions,
	reopenGame,
	seatByClan,
	setPool,
	setSideNames,
	startGame,
	syncTrackedItems,
	undoClaim,
	updateScoring,
	type Connect4Snapshot
} from '$lib/server/connect4';
import {
	ALL_POOL_OPTIONS,
	autoSelect,
	poolCandidates,
	randomSelect,
	toPoolOptions,
	toTileRefs,
	type PoolCandidate,
	type PoolOptions
} from '$lib/server/connect4Pool';
import { simulateDinkDrop, maybeProcessDinkDrops } from '$lib/server/dinkDrops';
import { liveVersion } from '$lib/server/liveVersion';
import { SIGNUP_EVENT_KIND } from '$lib/events/signupForm';
import { isSide, type Side } from '$lib/connect4/rules';

/**
 * Events whose signups can seat this game. Signup forms are the normal case — the roster
 * for a clan-vs-clan is collected on one before the game exists — and the game's own
 * signups are always available as "whoever is already here".
 */
async function signupSources(eventId: string): Promise<{ id: string; name: string }[]> {
	const { data } = await db()
		.from('vs_events')
		.select('id, name')
		.eq('kind', SIGNUP_EVENT_KIND)
		.order('created_at', { ascending: false })
		.limit(25);
	return ((data ?? []) as { id: string; name: string }[]).filter((e) => e.id !== eventId);
}
import type { Actions, PageServerLoad } from './$types';

// The Connect Four tester. Every phase of a game can be driven from here by hand —
// curate the pool, put people on sides, start, simulate a drop through the REAL pipeline,
// credit a column manually, undo a piece — so a whole game can be rehearsed without
// waiting on real drops. Admin-only; members watch at /events/[slug]/connect4.

export const load: PageServerLoad = async ({ params, locals }) => {
	if (!locals.user) throw redirect(303, '/');
	if (!isAdmin(locals.user)) throw redirect(303, '/');

	const game = await loadConnect4(params.slug);
	if (!game) throw error(404, 'No such Connect Four game');

	// Poll-on-read, the house pattern: nudge the drop consumer so a real drop reaches the
	// board without a scheduler, then heal the tracked-item projection in case a claim died
	// between its insert and its sync.
	//
	// Order matters, and so does the count: this used to sync FIRST and then re-load, which
	// meant three full snapshot reads per page load (one here, one inside the sync, one for
	// the re-read) — a third of the latency on every credit. Draining first means the single
	// re-read already contains anything that just landed, and the sync gets handed that
	// snapshot rather than fetching its own.
	if (game.phase === 'live') await maybeProcessDinkDrops();
	const fresh = (await loadConnect4(params.slug)) ?? game;
	await syncTrackedItems(fresh.id, fresh);

	// The roster to assign from: everyone with a site account. Signed-up members are
	// flagged so the panel can show who is already playing.
	// Paged: the roster is well past PostgREST's 1000-row cap at clan scale.
	const users = await fetchAllFiltered<{ id: string; rsn: string | null }>((from, to) =>
		db().from('vs_users').select('id, rsn').not('rsn', 'is', null).order('rsn').range(from, to)
	);

	const sideByUser = new Map<string, Side>();
	for (const s of fresh.sides) for (const m of s.members) sideByUser.set(m.userId, s.side);

	// Candidates are only needed while curating, and there are ~300 of them. Hand-added
	// custom tasks lead the list so they're never lost in the generated crowd.
	const candidates = fresh.phase === 'setup' ? await allCandidates(fresh) : [];

	return {
		// Baseline for the page's live-updates poll, computed alongside the payload so a
		// change landing between render and the first poll still gets caught.
		live: await liveVersion(fresh.id),
		game: {
			...fresh,
			// The rail and the board don't need the undealt deck, and it is a 250-entry
			// array on every load.
			deck: [],
			pool: fresh.phase === 'setup' ? fresh.pool : []
		},
		roster: (users.data ?? []).map((u) => ({
			id: u.id,
			rsn: u.rsn,
			side: sideByUser.get(u.id) ?? null
		})),
		candidates,
		// Rosters a clan-vs-clan game can be seated from — normally the signup form the
		// list was collected on.
		signupSources: await signupSources(fresh.id),
		// Distinct drop sources, for the "any drop from…" group-tile builder.
		groupSources:
			fresh.phase === 'setup'
				? [...new Set(candidates.map((c) => c.source).filter((s): s is string => !!s))].sort()
				: [],
		poolCount: fresh.pool.length,
		deckSize: fresh.deckSize
	};
};

/**
 * The curation universe for this game: its hand-added custom tasks first (flagged by
 * their negative ids), then the generated candidates shaped by the game's stored
 * generator filters. Auto/random fill draws from this same list. Pass `opts` to
 * override the filters — setPool validates against ALL_POOL_OPTIONS so a tightened
 * filter can never invalidate tiles that are already ticked.
 */
async function allCandidates(snap: Connect4Snapshot, opts?: PoolOptions): Promise<PoolCandidate[]> {
	const generated = await poolCandidates(opts ?? toPoolOptions(snap.poolOpts));
	// Spread keeps a custom's any_of group and qty riding through curation.
	const custom: PoolCandidate[] = snap.custom.map((t) => ({
		...t,
		ehb: t.ehb ?? 0,
		mechanic: 'custom'
	}));
	return [...custom, ...generated];
}

/** Auto/random fill both draw from the ehb-sorted filtered universe, customs included. */
async function fillCandidates(snap: Connect4Snapshot): Promise<PoolCandidate[]> {
	return (await allCandidates(snap)).sort((a, b) => a.ehb - b.ehb);
}

const sideOf = (form: FormData, key = 'side'): Side | null => {
	const n = Number(form.get(key));
	return isSide(n) ? n : null;
};

export const actions: Actions = {
	assign: async ({ request, locals, params }) => {
		if (!locals.user || !isAdmin(locals.user)) return fail(403, { error: 'Admins only' });
		const form = await request.formData();
		const game = await loadConnect4(params.slug);
		if (!game) return fail(404, { error: 'No such game' });
		const userIds = form.getAll('userId').map(String).filter(Boolean);
		if (!userIds.length) return fail(400, { error: 'Pick at least one member' });
		const raw = String(form.get('side') ?? '');
		const side = raw === 'none' ? null : sideOf(form);
		if (raw !== 'none' && side === null) return fail(400, { error: 'Pick a side' });

		// "Enrol" both signs them up and seats them, so one button works whether or not the
		// member has ever touched this event.
		const res = side === null
			? await assignSides({ eventId: game.id, userIds, side: null })
			: await enrolMembers({ eventId: game.id, userIds, side });
		return res.ok ? { assigned: userIds.length } : fail(400, { error: res.error });
	},

	seatByClan: async ({ request, locals, params }) => {
		if (!locals.user || !isAdmin(locals.user)) return fail(403, { error: 'Admins only' });
		const form = await request.formData();
		const game = await loadConnect4(params.slug);
		if (!game) return fail(404, { error: 'No such game' });
		const res = await seatByClan({
			eventId: game.id,
			sourceEventId: String(form.get('sourceEventId') ?? '') || null,
			clanSide: sideOf(form) ?? 1,
			dryRun: form.get('dryRun') === '1'
		});
		return res.ok ? { seating: res.value } : fail(400, { error: res.error });
	},

	setPool: async ({ request, locals, params }) => {
		if (!locals.user || !isAdmin(locals.user)) return fail(403, { error: 'Admins only' });
		const form = await request.formData();
		const game = await loadConnect4(params.slug);
		if (!game) return fail(404, { error: 'No such game' });

		const ids = new Set(form.getAll('itemId').map((v) => Number(v)));
		const all = await allCandidates(game, ALL_POOL_OPTIONS);
		const chosen = all.filter((c) => ids.has(c.item_id));
		// Per-tile knobs from the curation inputs: qty_<id> (drops one side needs to claim
		// ONE tile) and copies_<id> (how many deck slots the tile occupies — each copy its
		// own race). Both travel for every ticked id, visible or filtered out of view.
		const knob = (key: string, max: number) => {
			const n = Math.round(Number(form.get(key)));
			return isFinite(n) && n > 1 ? Math.min(max, n) : 1;
		};
		const tiles = toTileRefs(chosen).flatMap((t) => {
			const qty = knob(`qty_${t.item_id}`, 99);
			const { qty: _drop, ...bare } = t;
			const one = qty > 1 ? { ...bare, qty } : bare;
			return Array.from({ length: knob(`copies_${t.item_id}`, 20) }, () => ({ ...one }));
		});
		const res = await setPool(game.id, tiles);
		return res.ok ? { pooled: tiles.length } : fail(400, { error: res.error });
	},

	autoPool: async ({ locals, params }) => {
		if (!locals.user || !isAdmin(locals.user)) return fail(403, { error: 'Admins only' });
		const game = await loadConnect4(params.slug);
		if (!game) return fail(404, { error: 'No such game' });
		const res = await setPool(game.id, toTileRefs(autoSelect(await fillCandidates(game), game.deckSize)));
		return res.ok ? { pooled: game.deckSize } : fail(400, { error: res.error });
	},

	// The re-rollable fill: same difficulty spread, different tiles every click.
	randomPool: async ({ locals, params }) => {
		if (!locals.user || !isAdmin(locals.user)) return fail(403, { error: 'Admins only' });
		const game = await loadConnect4(params.slug);
		if (!game) return fail(404, { error: 'No such game' });
		const res = await setPool(game.id, toTileRefs(randomSelect(await fillCandidates(game), game.deckSize)));
		return res.ok ? { pooled: game.deckSize } : fail(400, { error: res.error });
	},

	// Save the generator filters, then the reload re-lists candidates through them.
	poolOpts: async ({ request, locals, params }) => {
		if (!locals.user || !isAdmin(locals.user)) return fail(403, { error: 'Admins only' });
		const form = await request.formData();
		const game = await loadConnect4(params.slug);
		if (!game) return fail(404, { error: 'No such game' });
		const res = await setPoolOptions(game.id, {
			min_ehb: Number(form.get('min_ehb')) || 0,
			max_ehb: Number(form.get('max_ehb')) || null,
			pets: form.get('pets') === 'on',
			jars: form.get('jars') === 'on',
			cosmetics: form.get('cosmetics') === 'on'
		});
		return res.ok ? { optsSaved: true } : fail(400, { error: res.error });
	},

	addCustom: async ({ request, locals, params }) => {
		if (!locals.user || !isAdmin(locals.user)) return fail(403, { error: 'Admins only' });
		const form = await request.formData();
		const game = await loadConnect4(params.slug);
		if (!game) return fail(404, { error: 'No such game' });
		const ehbRaw = String(form.get('ehb') ?? '').trim();

		// Group members, either way the form offers them: every unique drop of the PICKED
		// SOURCES (multi-select — "any raids purple" is all three raid chests at once),
		// and/or a hand-typed comma/newline list. Names found among the generated
		// candidates take that item's real id (id-matching); unknown names match by name.
		const cands = await poolCandidates(ALL_POOL_OPTIONS);
		const anyOf: { item_id: number | null; item_name: string }[] = [];
		const groupSources = form.getAll('any_of_source').map((s) => String(s).trim()).filter(Boolean);
		if (groupSources.length) {
			const want = new Set(groupSources.map((s) => s.toLowerCase()));
			for (const c of cands) {
				if (want.has((c.source ?? '').toLowerCase())) {
					anyOf.push({ item_id: c.item_id, item_name: c.item_name });
				}
			}
			if (!anyOf.length) {
				return fail(400, { error: `No priced drops found for ${groupSources.join(', ')}`, custom: true });
			}
		}
		for (const raw of String(form.get('any_of_items') ?? '').split(/[,\n]/)) {
			const name = raw.trim();
			if (!name) continue;
			const known = cands.find((c) => c.item_name.toLowerCase() === name.toLowerCase());
			anyOf.push({ item_id: known?.item_id ?? null, item_name: known?.item_name ?? name });
		}

		const res = await addCustomTile(game.id, {
			item_name: String(form.get('item_name') ?? ''),
			source: String(form.get('source') ?? '').trim() || (groupSources.join(' / ') || null),
			ehb: ehbRaw === '' ? null : Number(ehbRaw),
			qty: Number(form.get('qty')) || null,
			any_of: anyOf.length ? anyOf : null
		});
		return res.ok
			? { customAdded: res.value!.tile.item_name, customMembers: res.value!.tile.any_of?.length ?? 0 }
			: fail(400, { error: res.error, custom: true });
	},

	removeCustom: async ({ request, locals, params }) => {
		if (!locals.user || !isAdmin(locals.user)) return fail(403, { error: 'Admins only' });
		const form = await request.formData();
		const game = await loadConnect4(params.slug);
		if (!game) return fail(404, { error: 'No such game' });
		const res = await removeCustomTile(game.id, Number(form.get('itemId')));
		return res.ok ? { customRemoved: true } : fail(400, { error: res.error });
	},

	start: async ({ locals, params }) => {
		if (!locals.user || !isAdmin(locals.user)) return fail(403, { error: 'Admins only' });
		const game = await loadConnect4(params.slug);
		if (!game) return fail(404, { error: 'No such game' });
		const res = await startGame(game.id);
		return res.ok ? { started: true } : fail(400, { error: res.error });
	},

	scoring: async ({ request, locals, params }) => {
		if (!locals.user || !isAdmin(locals.user)) return fail(403, { error: 'Admins only' });
		const form = await request.formData();
		const game = await loadConnect4(params.slug);
		if (!game) return fail(404, { error: 'No such game' });
		const num = (k: string, d: number) => {
			const n = Number(form.get(k));
			return isFinite(n) ? n : d;
		};
		const res = await updateScoring(game.id, {
			tile_points: num('tile_points', game.scoring.tile_points),
			line_points: [4, 5, 6, 7].map((len, i) => ({
				len,
				points: num(`line_${len}`, game.scoring.line_points[i]?.points ?? 0)
			})),
			extra_per_cell: num('extra_per_cell', game.scoring.extra_per_cell)
		});
		return res.ok ? { scored: true } : fail(400, { error: res.error });
	},

	rename: async ({ request, locals, params }) => {
		if (!locals.user || !isAdmin(locals.user)) return fail(403, { error: 'Admins only' });
		const form = await request.formData();
		const game = await loadConnect4(params.slug);
		if (!game) return fail(404, { error: 'No such game' });
		const res = await setSideNames(game.id, [
			String(form.get('side1') ?? '').trim() || game.sides[0].name,
			String(form.get('side2') ?? '').trim() || game.sides[1].name
		]);
		return res.ok ? { renamed: true } : fail(400, { error: res.error });
	},

	credit: async (event) => {
		const { request, locals, params } = event;
		if (!locals.user || !isAdmin(locals.user)) return fail(403, { error: 'Admins only' });
		const form = await request.formData();
		const game = await loadConnect4(params.slug);
		if (!game) return fail(404, { error: 'No such game' });
		const side = sideOf(form);
		const col = Number(form.get('col'));
		if (side === null || !isFinite(col)) return fail(400, { error: 'Pick a side and a column' });

		const res = await creditManual({ eventId: game.id, side, col, byUserId: locals.user.id });
		if (res.status !== 'claimed') return fail(400, { error: res.error ?? `Could not credit (${res.status})` });
		await logAudit(event, 200, {
			action: 'connect4.credit',
			event: game.slug,
			side,
			cell: res.cell,
			tile: res.tile?.item_name
		});
		return {
			claim: {
				cell: res.cell,
				side,
				col,
				tile: res.tile?.item_name ?? null,
				runs: res.newRuns?.length ?? 0,
				// The tile that dropped into the emptied slot. claimTile already knows it, and
				// sending it back lets the rail swap in the new objective when the POST answers
				// instead of waiting for the reload behind it.
				replacement: res.replacement ?? null
			}
		};
	},

	simulate: async ({ request, locals, params }) => {
		if (!locals.user || !isAdmin(locals.user)) return fail(403, { error: 'Admins only' });
		const form = await request.formData();
		const game = await loadConnect4(params.slug);
		if (!game) return fail(404, { error: 'No such game' });
		const col = Number(form.get('col'));
		const userId = String(form.get('userId') ?? '');
		const slot = game.live[col];
		if (!slot) return fail(400, { error: 'That column has no tile' });

		const { data: u } = await db().from('vs_users').select('rsn').eq('id', userId).maybeSingle();
		const rsn = (u as { rsn: string | null } | null)?.rsn;
		if (!rsn) return fail(400, { error: 'Pick a member with an RSN' });

		// Goes in as a real vs_dink_drops row and comes back out through the real consumer,
		// so this exercises matching, side resolution, the claim and the projection.
		const res = await simulateDinkDrop({
			event_id: game.id,
			rsn,
			item_id: slot.tile.item_id,
			item_name: slot.tile.item_name,
			source: slot.tile.source,
			received_at: new Date().toISOString()
		});
		return res.ok
			? { simulated: { rsn, item: slot.tile.item_name, credited: res.credited } }
			: fail(400, { error: res.error ?? 'Simulation failed' });
	},

	undo: async (event) => {
		const { request, locals, params } = event;
		if (!locals.user || !isAdmin(locals.user)) return fail(403, { error: 'Admins only' });
		const form = await request.formData();
		const game = await loadConnect4(params.slug);
		if (!game) return fail(404, { error: 'No such game' });
		const pieceId = String(form.get('pieceId') ?? '');
		const res = await undoClaim({ eventId: game.id, pieceId });
		if (!res.ok) return fail(400, { error: res.error });
		await logAudit(event, 200, {
			action: 'connect4.undo',
			event: game.slug,
			cell: res.value?.cell
		});
		return { undone: res.value?.cell ?? true };
	},

	finish: async ({ locals, params }) => {
		if (!locals.user || !isAdmin(locals.user)) return fail(403, { error: 'Admins only' });
		const game = await loadConnect4(params.slug);
		if (!game) return fail(404, { error: 'No such game' });
		const res = await finishGame(game.id);
		return res.ok ? { finished: true } : fail(400, { error: res.error });
	},

	reopen: async ({ locals, params }) => {
		if (!locals.user || !isAdmin(locals.user)) return fail(403, { error: 'Admins only' });
		const game = await loadConnect4(params.slug);
		if (!game) return fail(404, { error: 'No such game' });
		const res = await reopenGame(game.id);
		return res.ok ? { reopened: true } : fail(400, { error: res.error });
	},

	resync: async ({ locals, params }) => {
		if (!locals.user || !isAdmin(locals.user)) return fail(403, { error: 'Admins only' });
		const game = await loadConnect4(params.slug);
		if (!game) return fail(404, { error: 'No such game' });
		const res = await syncTrackedItems(game.id);
		return res.ok ? { resynced: res.value } : fail(400, { error: res.error });
	}
};
