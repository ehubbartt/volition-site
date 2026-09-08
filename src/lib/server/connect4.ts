// Connect Four — server store and actions. Loads a game into a snapshot, validates every
// action through the pure rules in $lib/connect4/rules, and writes.
//
// See docs/CONNECT4.md. Three things here are load-bearing and easy to break:
//
//  1. NOTHING IS ACCUMULATED. Scores, the live tile above each column, the winner and the
//     board itself are all derived from vs_connect4_pieces on every read. That is what
//     makes `undoClaim` correct without a compensating write, and it is why a claim that
//     lands twice cannot bank anything twice.
//
//  2. THE CLAIM IS ARBITRATED BY THE DATABASE. Two teams racing the same shared tile both
//     compute the same landing cell and both INSERT; `unique (event_id, col, row)` decides
//     which one lands, and the loser is told it was beaten. Never read-then-write here —
//     the Dink consumer can be draining two batches at once, in two processes.
//
//  3. THE TRACKED-ITEM ROWS ARE A PROJECTION, NEVER A SOURCE. `syncTrackedItems` mirrors
//     the 25 live tiles into vs_event_tracked_items so they reach the Dink proxy's
//     allowlist (branch 1 of vs_active_player_tiles) with no proxy change. A claim always
//     re-derives the live tile from the pieces, so a stale projection can only mean a drop
//     was recorded needlessly or missed — never that the wrong tile was credited.

import { randomUUID } from 'node:crypto';
import { clanMemberIds } from './clan';
import { normalizePoolOpts, type StoredPoolOpts } from './connect4Pool';
import { db, fetchAllFiltered } from './db';
import {
	COLS,
	DECK_SIZE,
	ROWS,
	cellId,
	clampSize,
	columnCounts,
	deckSizeOf,
	landingRow,
	leaderOf,
	liveTiles,
	matchesTile,
	normalizeScoring,
	runsThrough,
	seededRandom,
	shuffleDeck,
	standings as computeStandings,
	tileQty,
	type BoardSize,
	type Connect4Scoring,
	type LiveTile,
	type Phase,
	type Piece,
	type Run,
	type Side,
	type SideStanding,
	type TileRef
} from '$lib/connect4/rules';

export const CONNECT4_KIND = 'connect4';

// Classic Connect Four: red and yellow. The board should read as the board game at a
// glance, so these are the pieces' colours, not a generic team accent.
const SIDE_COLORS = ['#ef4444', '#eab308'];
const DEFAULT_SIDE_NAMES = ['Red', 'Yellow'];

// ── Types ───────────────────────────────────────────────────────────────────

export interface Connect4Side {
	side: Side;
	name: string;
	color: string;
	teamId: string | null;
	members: SideMember[];
}

export interface SideMember {
	userId: string;
	rsn: string | null;
	discordId: string | null;
}

export interface Connect4Snapshot {
	id: string;
	slug: string;
	name: string;
	description: string | null;
	status: string;
	phase: Phase;
	test: boolean;
	scoring: Connect4Scoring;
	/** Board dimensions, fixed at creation. Classic is 25×10. */
	cols: number;
	rows: number;
	/** cols × rows — how many tiles the pool needs and the board can hold. */
	deckSize: number;
	startsAt: string | null;
	endsAt: string | null;
	/** The curated pool (one tile per cell), in the admin's chosen order. Empty until set. */
	pool: TileRef[];
	/** Hand-added custom tasks offered alongside the generated candidates (setup only). */
	custom: TileRef[];
	/** Generator filters, normalized (setup-time knobs; never constrain a saved pool). */
	poolOpts: StoredPoolOpts;
	/** The dealt deck — admin-only; strip it before a member ever sees the snapshot. */
	deck: TileRef[];
	seed: number | null;
	sides: Connect4Side[];
	/** Signed-up members not yet put on a side. */
	unassigned: SideMember[];
	pieces: Piece[];
	live: (LiveTile | null)[];
	standings: SideStanding[];
	winner: Side | null;
	/** True once every cell is claimed — the game has run out of board. */
	full: boolean;
}

type Result<T = undefined> = { ok: true; value?: T } | { ok: false; error: string };

const okResult = <T>(value?: T): Result<T> => ({ ok: true, value });
const errResult = (error: string): Result<never> => ({ ok: false, error });

// ── Structure helpers ───────────────────────────────────────────────────────

interface StructureC4 {
	phase?: Phase;
	test?: boolean;
	scoring?: Connect4Scoring;
	/** Board dimensions; absent on games created before sizes were configurable (25×10). */
	size?: { cols: number; rows: number };
	/** Generator filters for the curation list and auto/random fill (see connect4Pool). */
	pool_opts?: Partial<StoredPoolOpts>;
	sides?: { side: Side; name: string; color: string; team_id: string | null }[];
	pool?: TileRef[];
	/** Hand-added custom tasks (negative synthetic item_id, name-matched). */
	custom?: TileRef[];
	deck?: TileRef[];
	seed?: number | null;
	winner?: Side | null;
}

function readStructure(structure: unknown): StructureC4 {
	if (!structure || typeof structure !== 'object') return {};
	const c4 = (structure as Record<string, unknown>).connect4;
	if (!c4 || typeof c4 !== 'object') return {};
	return c4 as StructureC4;
}

/**
 * Merge a patch into `structure.connect4`, preserving every other structure key.
 * Read-modify-write on a jsonb column: fine for the phase and the deal, which are written
 * by single admin actions. Never used for pieces — those are rows, with a unique index.
 */
async function patchStructure(eventId: string, patch: Partial<StructureC4>): Promise<Result> {
	const sb = db();
	const { data, error } = await sb.from('vs_events').select('structure').eq('id', eventId).maybeSingle();
	if (error) return errResult(error.message);
	const structure = (data?.structure ?? {}) as Record<string, unknown>;
	const c4 = { ...(readStructure(structure) as Record<string, unknown>), ...patch };
	const { error: uErr } = await sb
		.from('vs_events')
		.update({ structure: { ...structure, connect4: c4 } })
		.eq('id', eventId);
	return uErr ? errResult(uErr.message) : okResult();
}

function rowToPiece(r: Record<string, unknown>): Piece {
	return {
		id: r.id as string,
		col: Number(r.col),
		row: Number(r.row),
		side: Number(r.side) as Side,
		deck_idx: Number(r.deck_idx),
		item_id: (r.item_id as number | null) ?? null,
		item_name: (r.item_name as string | null) ?? null,
		source: (r.source as string | null) ?? null,
		by_user_id: (r.by_user_id as string | null) ?? null,
		drop_key: r.drop_key as string,
		claimed_at: r.claimed_at as string
	};
}

async function readPieces(eventId: string): Promise<Piece[]> {
	const { data } = await db()
		.from('vs_connect4_pieces')
		.select('*')
		.eq('event_id', eventId)
		.order('claimed_at', { ascending: true });
	return ((data ?? []) as Record<string, unknown>[]).map(rowToPiece);
}

// ── Load ────────────────────────────────────────────────────────────────────

/**
 * Full snapshot, including the undealt deck. Server-only; run it through
 * `redactSnapshot` before it reaches anyone who isn't an admin — the rest of the deck is
 * the only hidden information in this game, and knowing what is coming up a column is
 * worth real points.
 */
export async function loadConnect4(slug: string): Promise<Connect4Snapshot | null> {
	const { data: ev } = await db()
		.from('vs_events')
		.select('id, slug, name, description, kind, status, structure, starts_at, ends_at')
		.eq('slug', slug)
		.maybeSingle();
	if (!ev || ev.kind !== CONNECT4_KIND) return null;
	return buildSnapshot(ev as EventRow);
}

export async function loadConnect4ById(eventId: string): Promise<Connect4Snapshot | null> {
	const { data: ev } = await db()
		.from('vs_events')
		.select('id, slug, name, description, kind, status, structure, starts_at, ends_at')
		.eq('id', eventId)
		.maybeSingle();
	if (!ev || ev.kind !== CONNECT4_KIND) return null;
	return buildSnapshot(ev as EventRow);
}

interface EventRow {
	id: string;
	slug: string;
	name: string;
	description: string | null;
	status: string;
	structure: unknown;
	starts_at: string | null;
	ends_at: string | null;
}

async function buildSnapshot(ev: EventRow): Promise<Connect4Snapshot> {
	const sb = db();
	const c4 = readStructure(ev.structure);

	const [{ data: signupRows }, pieces] = await Promise.all([
		sb.from('vs_event_signups').select('user_id, team_id').eq('event_id', ev.id),
		readPieces(ev.id)
	]);
	const signups = (signupRows ?? []) as { user_id: string; team_id: string | null }[];

	// One roster read so every member carries an RSN for display.
	const userIds = [...new Set(signups.map((s) => s.user_id))];
	const usersById = new Map<string, { rsn: string | null; discordId: string | null }>();
	if (userIds.length) {
		const { data: us } = await sb.from('vs_users').select('id, rsn, discord_id').in('id', userIds);
		for (const u of (us ?? []) as { id: string; rsn: string | null; discord_id: string | null }[]) {
			usersById.set(u.id, { rsn: u.rsn, discordId: u.discord_id });
		}
	}
	const asMember = (userId: string): SideMember => ({
		userId,
		rsn: usersById.get(userId)?.rsn ?? null,
		discordId: usersById.get(userId)?.discordId ?? null
	});

	const sideDefs = c4.sides?.length
		? c4.sides
		: ([1, 2] as Side[]).map((side) => ({
				side,
				name: DEFAULT_SIDE_NAMES[side - 1],
				color: SIDE_COLORS[side - 1],
				team_id: null
			}));

	const sides: Connect4Side[] = sideDefs.map((d) => ({
		side: d.side,
		name: d.name,
		color: d.color,
		teamId: d.team_id,
		members: signups.filter((s) => s.team_id && s.team_id === d.team_id).map((s) => asMember(s.user_id))
	}));

	// Stamp each piece with the claimant's RSN so the log reads without a second query.
	for (const p of pieces) p.by_rsn = p.by_user_id ? (usersById.get(p.by_user_id)?.rsn ?? null) : null;

	const scoring = normalizeScoring(c4.scoring);
	const size = clampSize(c4.size);
	const deck = Array.isArray(c4.deck) ? c4.deck : [];
	const phase: Phase = c4.phase ?? 'setup';

	// Per-side progress toward quantity tiles, attached to the live slots. One extra
	// query, and only for games that actually deal a qty tile.
	const live = deck.length ? liveTiles(deck, pieces, size) : new Array(size.cols).fill(null);
	if (deck.some((t) => tileQty(t) > 1)) {
		const idxs = live.filter((l): l is LiveTile => !!l && tileQty(l.tile) > 1).map((l) => l.deckIdx);
		if (idxs.length) {
			const { data: prog } = await sb
				.from('vs_connect4_progress')
				.select('deck_idx, side')
				.eq('event_id', ev.id)
				.in('deck_idx', idxs);
			const counts = new Map<number, { 1: number; 2: number }>();
			for (const r of (prog ?? []) as { deck_idx: number; side: Side }[]) {
				const c = counts.get(r.deck_idx) ?? { 1: 0, 2: 0 };
				c[r.side] += 1;
				counts.set(r.deck_idx, c);
			}
			for (const l of live) {
				if (l && tileQty(l.tile) > 1) l.progress = counts.get(l.deckIdx) ?? { 1: 0, 2: 0 };
			}
		}
	}

	return {
		id: ev.id,
		slug: ev.slug,
		name: ev.name,
		description: ev.description,
		status: ev.status,
		phase,
		test: c4.test ?? false,
		scoring,
		cols: size.cols,
		rows: size.rows,
		deckSize: deckSizeOf(size),
		startsAt: ev.starts_at,
		endsAt: ev.ends_at,
		pool: Array.isArray(c4.pool) ? c4.pool : [],
		custom: Array.isArray(c4.custom) ? c4.custom : [],
		poolOpts: normalizePoolOpts(c4.pool_opts),
		deck,
		seed: c4.seed ?? null,
		sides,
		unassigned: signups.filter((s) => !s.team_id).map((s) => asMember(s.user_id)),
		pieces,
		live,
		standings: computeStandings(pieces, scoring),
		winner: c4.winner ?? null,
		full: pieces.length >= deckSizeOf(size)
	};
}

/** The snapshot's board size, for the rules helpers. */
const sizeOf = (snap: Connect4Snapshot): BoardSize => ({ cols: snap.cols, rows: snap.rows });

/**
 * What a non-admin may see. The board, the tiles on offer and the scores are all public —
 * this is a shared board and both sides watch the same race. The only secret is what
 * hasn't been dealt yet, so the deck is trimmed to the tiles currently on offer.
 */
export function redactSnapshot(snap: Connect4Snapshot, isAdmin: boolean): Connect4Snapshot {
	if (isAdmin) return snap;
	return { ...snap, deck: [], pool: [], custom: [] };
}

// ── Create & configure ──────────────────────────────────────────────────────

export async function createConnect4(input: {
	slug: string;
	name: string;
	description?: string | null;
	ownerUserId: string;
	scoring?: Partial<Connect4Scoring>;
	sideNames?: [string, string];
	/** Board dimensions — clamped to sane bounds; omitted = the classic 25×10. */
	cols?: number;
	rows?: number;
	test?: boolean;
}): Promise<Result<{ id: string; slug: string }>> {
	const sb = db();
	const names = input.sideNames ?? (DEFAULT_SIDE_NAMES as [string, string]);

	const connect4: StructureC4 = {
		phase: 'setup',
		test: input.test ?? false,
		scoring: normalizeScoring(input.scoring),
		size: clampSize({ cols: input.cols, rows: input.rows }),
		pool: [],
		custom: [],
		deck: [],
		seed: null,
		winner: null
	};

	// `draft` until the game starts: branch 1 of the active-tiles view only offers tiles
	// for an `open` event, so a game being set up can't put anything in the allowlist.
	const { data, error } = await sb
		.from('vs_events')
		.insert({
			slug: input.slug,
			name: input.name,
			description: input.description ?? null,
			kind: CONNECT4_KIND,
			status: 'draft',
			team_size: 1,
			unlisted: true,
			structure: { connect4 }
		})
		.select('id, slug')
		.single();
	if (error || !data) return errResult(error?.message ?? 'Could not create the event');

	// Two teams up front so a member can be assigned to a side before the game starts.
	const { data: teamRows, error: tErr } = await sb
		.from('vs_teams')
		.insert(names.map((name) => ({ event_id: data.id, name, created_by: input.ownerUserId })))
		.select('id, name');
	if (tErr) return errResult(tErr.message);

	const teams = (teamRows ?? []) as { id: string; name: string }[];
	const sides = names.map((name, i) => ({
		side: (i + 1) as Side,
		name,
		color: SIDE_COLORS[i],
		team_id: teams.find((t) => t.name === name)?.id ?? null
	}));
	const patched = await patchStructure(data.id, { sides });
	if (!patched.ok) return errResult(patched.error);

	return okResult({ id: data.id, slug: data.slug });
}

/** Replace the curated pool. Setup only — the deal is made from it, once, at start. */
export async function setPool(eventId: string, tiles: TileRef[]): Promise<Result<{ count: number }>> {
	const snap = await loadConnect4ById(eventId);
	if (!snap) return errResult('No such game');
	if (snap.phase !== 'setup') return errResult('The pool is locked once the game starts');
	if (tiles.length !== snap.deckSize) {
		return errResult(`Pick exactly ${snap.deckSize} tiles — ${tiles.length} selected`);
	}
	// Repeats are legal ON PURPOSE: a tile's "copies" put the same item in several deck
	// slots, each its own race. Everything downstream already counts copies (racedOutBy,
	// per-slot progress); the old same-item-twice guard predates them.

	const res = await patchStructure(eventId, { pool: tiles });
	return res.ok ? okResult({ count: tiles.length }) : errResult(res.error);
}

/**
 * Hand-add a custom task to the game's candidate list — anything the generated boss-drop
 * universe doesn't offer. A plain custom matches drops by NAME (the synthetic negative id
 * exists only so list UIs can key it), so the name must be exactly what Dink reports for
 * the item. With `any_of`, the name is just the DISPLAY name ("Any CoX purple") and any
 * listed item qualifies; with `qty`, one side needs that many qualifying drops. Setup
 * only; the tile still has to be ticked into the pool like any other candidate.
 */
export async function addCustomTile(
	eventId: string,
	input: {
		item_name: string;
		source?: string | null;
		ehb?: number | null;
		qty?: number | null;
		any_of?: { item_id: number | null; item_name: string }[] | null;
	}
): Promise<Result<{ tile: TileRef }>> {
	const snap = await loadConnect4ById(eventId);
	if (!snap) return errResult('No such game');
	if (snap.phase !== 'setup') return errResult('Custom tasks are added during setup');

	const name = input.item_name.trim();
	if (!name) return errResult('Give the task a name');
	const clash = [...snap.custom, ...snap.pool].some(
		(t) => t.item_name.trim().toLowerCase() === name.toLowerCase()
	);
	if (clash) return errResult('A tile with that name already exists');

	// Group members: trimmed, deduped case-insensitively, bounded so a paste of a whole
	// item database doesn't turn one tile into hundreds of allowlist rows. 60 covers
	// "any purple from any raid" (all three raid chests together) with room to spare.
	const seen = new Set<string>();
	const anyOf = (input.any_of ?? [])
		.map((m) => ({ item_id: m.item_id, item_name: m.item_name.trim() }))
		.filter((m) => {
			const k = m.item_name.toLowerCase();
			if (!m.item_name || seen.has(k)) return false;
			seen.add(k);
			return true;
		})
		.slice(0, 60);

	const ehb = Number(input.ehb);
	const qty = Math.round(Number(input.qty));
	const tile: TileRef = {
		// Unique within the game and always negative — see matchesTile.
		item_id: Math.min(0, ...snap.custom.map((t) => t.item_id)) - 1,
		item_name: name,
		source: input.source?.trim() || null,
		...(isFinite(ehb) && ehb > 0 ? { ehb } : {}),
		...(anyOf.length ? { any_of: anyOf } : {}),
		...(isFinite(qty) && qty > 1 ? { qty: Math.min(99, qty) } : {})
	};
	const res = await patchStructure(eventId, { custom: [...snap.custom, tile] });
	return res.ok ? okResult({ tile }) : errResult(res.error);
}

/** Save the generator filters (setup only — they only shape what the list offers). */
export async function setPoolOptions(
	eventId: string,
	opts: Partial<StoredPoolOpts>
): Promise<Result<{ opts: StoredPoolOpts }>> {
	const snap = await loadConnect4ById(eventId);
	if (!snap) return errResult('No such game');
	if (snap.phase !== 'setup') return errResult('Filters only matter during setup');
	const normalized = normalizePoolOpts(opts);
	const res = await patchStructure(eventId, { pool_opts: normalized });
	return res.ok ? okResult({ opts: normalized }) : errResult(res.error);
}

/** Remove a hand-added task (setup only). It also leaves the pool if it was ticked in. */
export async function removeCustomTile(eventId: string, itemId: number): Promise<Result> {
	const snap = await loadConnect4ById(eventId);
	if (!snap) return errResult('No such game');
	if (snap.phase !== 'setup') return errResult('Custom tasks are edited during setup');
	const custom = snap.custom.filter((t) => t.item_id !== itemId);
	if (custom.length === snap.custom.length) return errResult('No such custom task');
	const pool = snap.pool.filter((t) => t.item_id !== itemId);
	const res = await patchStructure(eventId, {
		custom,
		...(pool.length !== snap.pool.length ? { pool } : {})
	});
	return res.ok ? okResult() : errResult(res.error);
}

export async function updateScoring(eventId: string, scoring: Partial<Connect4Scoring>): Promise<Result> {
	// Deliberately allowed mid-game: standings are recomputed from the piece log on every
	// read, so retuning the numbers re-scores the whole board with no migration.
	return patchStructure(eventId, { scoring: normalizeScoring(scoring) });
}

export async function setSideNames(eventId: string, names: [string, string]): Promise<Result> {
	const snap = await loadConnect4ById(eventId);
	if (!snap) return errResult('No such game');
	const sides = snap.sides.map((s, i) => ({
		side: s.side,
		name: names[i]?.trim() || s.name,
		color: s.color,
		team_id: s.teamId
	}));
	const sb = db();
	await Promise.all(
		sides.filter((s) => s.team_id).map((s) => sb.from('vs_teams').update({ name: s.name }).eq('id', s.team_id!))
	);
	return patchStructure(eventId, { sides });
}

// ── Team assignment ─────────────────────────────────────────────────────────

/**
 * Put members on a side (or take them off with `side: null`). One statement for the whole
 * batch — assigning 120 people one call at a time is how the Battleship draft first timed
 * out. Members must already be signed up; this only moves `team_id`.
 */
export async function assignSides(input: {
	eventId: string;
	userIds: string[];
	side: Side | null;
}): Promise<Result<{ moved: number }>> {
	if (!input.userIds.length) return okResult({ moved: 0 });
	const snap = await loadConnect4ById(input.eventId);
	if (!snap) return errResult('No such game');

	let teamId: string | null = null;
	if (input.side !== null) {
		teamId = snap.sides.find((s) => s.side === input.side)?.teamId ?? null;
		if (!teamId) return errResult('That side has no team row — recreate the game');
	}

	const { data, error } = await db()
		.from('vs_event_signups')
		.update({ team_id: teamId })
		.eq('event_id', input.eventId)
		.in('user_id', input.userIds)
		.select('user_id');
	if (error) return errResult(error.message);
	return okResult({ moved: (data ?? []).length });
}

/**
 * Sign members up and put them on a side in one go — the admin path for building a roster
 * from the signup event's list, or for adding the opposing clan as they onboard. Existing
 * signups are left in place (the insert ignores duplicates) and then assigned.
 */
export async function enrolMembers(input: {
	eventId: string;
	userIds: string[];
	side: Side | null;
}): Promise<Result<{ enrolled: number }>> {
	if (!input.userIds.length) return okResult({ enrolled: 0 });
	const sb = db();
	const { error } = await sb
		.from('vs_event_signups')
		.upsert(
			input.userIds.map((user_id) => ({ event_id: input.eventId, user_id })),
			{ onConflict: 'event_id,user_id', ignoreDuplicates: true }
		);
	if (error) return errResult(error.message);
	const assigned = await assignSides(input);
	if (!assigned.ok) return errResult(assigned.error);
	return okResult({ enrolled: input.userIds.length });
}

/**
 * SEAT A WHOLE CLAN-VS-CLAN ROSTER IN ONE GO.
 *
 * For a 120-v-120 there is no draft to run — the sides are decided before anyone signs up,
 * by which clan you are in. The authority for that is the bot's `players` table: a Volition
 * member is in it, an opposing clan's member is not. (`vs_users.clan_allegiance` is
 * self-declared at onboarding and would let anyone put themselves on either side.)
 *
 * `sourceEventId` is where the people come from — normally the signup form the roster was
 * collected on. Everyone found there is signed up to THIS game as well, which is also what
 * puts them in the Dink allowlist (`vs_active_player_tiles` branch 1).
 *
 * `dryRun` answers without writing, because the failure mode worth catching is a Volition
 * member whose site account was never linked to their `players` row landing on the other
 * side. Look at the split first; the per-member buttons fix the exceptions afterwards.
 */
export interface SeatReport {
	sourceName: string;
	clan: { id: string; rsn: string | null }[];
	visitors: { id: string; rsn: string | null }[];
	/**
	 * Visitors who say on their own profile that they ARE Volition. Almost always a member
	 * whose site account was never linked to their player row rather than someone lying, so
	 * they are the list to check by hand before the game starts.
	 */
	flagged: { id: string; rsn: string | null }[];
	seated: number;
	dryRun: boolean;
}

export async function seatByClan(input: {
	eventId: string;
	sourceEventId?: string | null;
	/** The side the clan takes. The other side gets everyone else. */
	clanSide?: Side;
	dryRun?: boolean;
}): Promise<Result<SeatReport>> {
	const sb = db();
	const sourceId = input.sourceEventId || input.eventId;
	const clanSide: Side = input.clanSide ?? 1;
	const otherSide: Side = clanSide === 1 ? 2 : 1;

	const { data: source } = await sb
		.from('vs_events')
		.select('name')
		.eq('id', sourceId)
		.maybeSingle();
	const sourceName = (source as { name: string } | null)?.name ?? 'this game';

	const { data: signups, error: sErr } = await fetchAllFiltered<{ user_id: string }>((from, to) =>
		sb.from('vs_event_signups').select('user_id').eq('event_id', sourceId).range(from, to)
	);
	if (sErr) return errResult(sErr.message);
	const userIds = [...new Set(signups.map((r) => r.user_id))];
	if (!userIds.length) return errResult(`Nobody has signed up to "${sourceName}"`);

	// Chunked: `in()` builds a URL, and a thousand uuids does not fit in one.
	const users: {
		id: string;
		discord_id: string | null;
		rsn: string | null;
		clan_allegiance: string | null;
	}[] = [];
	for (let i = 0; i < userIds.length; i += 200) {
		const { data, error } = await sb
			.from('vs_users')
			.select('id, discord_id, rsn, clan_allegiance')
			.in('id', userIds.slice(i, i + 200));
		if (error) return errResult(error.message);
		users.push(...((data ?? []) as typeof users));
	}

	const inClan = await clanMemberIds(users);
	const byRsn = (a: { rsn: string | null }, b: { rsn: string | null }) =>
		(a.rsn ?? '').localeCompare(b.rsn ?? '');
	const clan = users.filter((u) => inClan.has(u.id)).map((u) => ({ id: u.id, rsn: u.rsn })).sort(byRsn);
	const out = users.filter((u) => !inClan.has(u.id));
	const visitors = out.map((u) => ({ id: u.id, rsn: u.rsn })).sort(byRsn);
	const flagged = out
		.filter((u) => u.clan_allegiance === 'volition')
		.map((u) => ({ id: u.id, rsn: u.rsn }))
		.sort(byRsn);

	if (input.dryRun) {
		return okResult({ sourceName, clan, visitors, flagged, seated: 0, dryRun: true });
	}

	for (const [side, group] of [
		[clanSide, clan],
		[otherSide, visitors]
	] as const) {
		if (!group.length) continue;
		const res = await enrolMembers({ eventId: input.eventId, userIds: group.map((u) => u.id), side });
		if (!res.ok) return errResult(res.error);
	}
	return okResult({
		sourceName,
		clan,
		visitors,
		flagged,
		seated: clan.length + visitors.length,
		dryRun: false
	});
}

/** Which side a member plays for in this game, or null if they aren't on one. */
export async function sideForUser(eventId: string, userId: string): Promise<Side | null> {
	const snap = await loadConnect4ById(eventId);
	if (!snap) return null;
	for (const s of snap.sides) {
		if (s.members.some((m) => m.userId === userId)) return s.side;
	}
	return null;
}

// ── Starting ────────────────────────────────────────────────────────────────

/**
 * Deal the deck and open the game. The shuffle happens exactly once and the seed is
 * stored, so the deal is reproducible and auditable afterwards.
 *
 * The phase flip is a true CAS (`… where structure->'connect4'->>'phase' = 'setup'`), so
 * two admins pressing Start at the same moment produce one deal rather than two.
 */
export async function startGame(eventId: string, seed?: number): Promise<Result<{ seed: number }>> {
	const snap = await loadConnect4ById(eventId);
	if (!snap) return errResult('No such game');
	if (snap.phase !== 'setup') return errResult('This game has already started');
	if (snap.pool.length !== snap.deckSize) return errResult(`Curate ${snap.deckSize} tiles first`);
	const anyMembers = snap.sides.some((s) => s.members.length > 0);
	if (!anyMembers) return errResult('Put at least one member on a side first');

	const usedSeed = seed ?? Math.floor(Math.random() * 2 ** 31);
	const deck = shuffleDeck(snap.pool, seededRandom(usedSeed));

	const sb = db();
	const { data: cur } = await sb.from('vs_events').select('structure').eq('id', eventId).maybeSingle();
	const structure = (cur?.structure ?? {}) as Record<string, unknown>;
	const c4 = { ...readStructure(structure), phase: 'live' as Phase, deck, seed: usedSeed };

	const { data: updated, error } = await sb
		.from('vs_events')
		.update({ structure: { ...structure, connect4: c4 }, status: 'open', starts_at: new Date().toISOString() })
		.eq('id', eventId)
		// The CAS: only the row still in `setup` is updated, so a second Start deals nothing.
		.eq('structure->connect4->>phase', 'setup')
		.select('id');
	if (error) return errResult(error.message);
	if (!updated?.length) return errResult('This game has already started');

	await syncTrackedItems(eventId);
	return okResult({ seed: usedSeed });
}

// ── The claim ───────────────────────────────────────────────────────────────

export type ClaimStatus =
	| 'claimed'
	| 'duplicate'
	| 'raced'
	| 'no_tile'
	| 'timing'
	| 'not_live'
	| 'blocked'
	/** Counted toward a quantity tile — the side is not at its N yet. Terminal per drop. */
	| 'progress'
	| 'error';

export interface ClaimReport {
	status: ClaimStatus;
	error?: string;
	col?: number;
	row?: number;
	cell?: string;
	side?: Side;
	tile?: TileRef;
	/** The tile that dropped into the emptied slot — what the board shows next. */
	replacement?: TileRef | null;
	/** Runs the new piece completed or extended, for the celebration. */
	newRuns?: Run[];
	standings?: SideStanding[];
	finished?: boolean;
	/** For quantity tiles: this side's banked drops and the tile's requirement. */
	have?: number;
	need?: number;
}

function isDropKeyConflict(err: { message?: string; details?: string | null }): boolean {
	const text = `${err.message ?? ''} ${err.details ?? ''}`;
	return text.includes('drop_key');
}

/**
 * Has this drop already claimed something here?
 *
 * The unique index is still the authority, but it can only speak when we get as far as an
 * INSERT — and on a re-run we usually don't: the column has moved on to a different tile,
 * so the match fails first and the drop looks like it credited nothing. The reconcile pass
 * re-runs drops for three days, so without this a credited drop would be stamped
 * "didn't credit" and re-processed forever.
 */
async function claimedBy(eventId: string, dropKey: string): Promise<Piece | null> {
	const { data } = await db()
		.from('vs_connect4_pieces')
		.select('*')
		.eq('event_id', eventId)
		.eq('drop_key', dropKey)
		.maybeSingle();
	return data ? rowToPiece(data as Record<string, unknown>) : null;
}

/**
 * Which piece, if any, a drop already claimed — anywhere.
 *
 * The Dink consumer needs this for a drop whose tile has since moved on: the item is no
 * longer in the allowlist, so the drop matches no candidate and would be filed as "didn't
 * credit" even though it put a piece on the board. Reads the unique (event_id, drop_key)
 * index.
 */
export async function pieceForDropKey(dropKey: string): Promise<{ eventId: string; col: number; row: number } | null> {
	const { data } = await db()
		.from('vs_connect4_pieces')
		.select('event_id, col, row')
		.eq('drop_key', dropKey)
		.limit(1);
	const row = (data ?? [])[0] as { event_id: string; col: number; row: number } | undefined;
	return row ? { eventId: row.event_id, col: row.col, row: row.row } : null;
}

/**
 * The piece that raced this item out — set only when EVERY copy of the item in the deck
 * has already been claimed. One unclaimed copy, live or still buried in a column, means a
 * re-run could yet credit, so that is not a loss and this returns null. (Decks are
 * normally one-copy-per-item, but nothing enforces it, so this counts rather than
 * assumes.)
 */
function racedOutBy(
	deck: TileRef[],
	pieces: Piece[],
	item: { item_id?: number | null; item_name?: string | null }
): Piece | null {
	const byIdx = new Map(pieces.map((p) => [p.deck_idx, p]));
	let winner: Piece | null = null;
	let copies = 0;
	for (let i = 0; i < deck.length; i++) {
		if (!matchesTile(item, deck[i])) continue;
		copies++;
		const claimed = byIdx.get(i);
		if (!claimed) return null;
		winner = claimed;
	}
	return copies ? winner : null;
}

/**
 * Did this drop lose the race for a shared tile? Answers with the winning column when a
 * live game the player is SIGNED UP to dealt the item and every copy of it has since been
 * claimed. The consumer needs this for a drop whose item no longer matches any allowlist
 * row: the winner's claim removed it, so without this the loser is filed `no_tile` and
 * re-surfaced by the reconcile pass for days. Scoped to the player's own games so a
 * raced-out item can never swallow a drop that a board created later (bingo, personal)
 * might legitimately still want.
 */
export async function racedOutOf(input: {
	userId: string;
	itemId?: number | null;
	itemName?: string | null;
}): Promise<{ eventId: string; col: number } | null> {
	const sb = db();
	const { data: evs } = await sb
		.from('vs_events')
		.select('id')
		.eq('kind', CONNECT4_KIND)
		.eq('status', 'open')
		.eq('structure->connect4->>phase', 'live');
	for (const ev of (evs ?? []) as { id: string }[]) {
		const { data: signup } = await sb
			.from('vs_event_signups')
			.select('id')
			.eq('event_id', ev.id)
			.eq('user_id', input.userId)
			.maybeSingle();
		if (!signup) continue;
		const snap = await loadConnect4ById(ev.id);
		if (!snap?.deck.length) continue;
		const winner = racedOutBy(snap.deck, snap.pieces, {
			item_id: input.itemId,
			item_name: input.itemName
		});
		if (winner) return { eventId: ev.id, col: winner.col };
	}
	return null;
}

/** Is any Connect Four game running? Lets the consumer skip the lookup above entirely. */
export async function anyLiveConnect4(): Promise<boolean> {
	const { data } = await db()
		.from('vs_events')
		.select('id')
		.eq('kind', CONNECT4_KIND)
		.eq('status', 'open')
		.eq('structure->connect4->>phase', 'live')
		.limit(1);
	return (data ?? []).length > 0;
}

function duplicateOf(piece: Piece): ClaimReport {
	return {
		status: 'duplicate',
		col: piece.col,
		row: piece.row,
		cell: cellId(piece.col, piece.row),
		side: piece.side
	};
}

/** A test game refuses anything that looks like real Dink traffic. */
function dropKeyAllowed(testGame: boolean, dropKey: string): boolean {
	if (!testGame) return true;
	return dropKey.startsWith('test-') || dropKey.startsWith('manual:') || dropKey.startsWith('admin:');
}

/**
 * Claim the tile a drop satisfies: drop a piece into that column for the given side.
 *
 * The decision is re-derived from the pieces every attempt and committed by INSERT. If
 * the cell is taken, the other side won the race for that tile; the column has moved on,
 * so we re-derive once and only retry if the NEW tile above it also matches this drop
 * (which happens when the same item was dealt to consecutive slots). Otherwise the drop
 * lost the race and claims nothing.
 */
export async function claimTile(input: {
	eventId: string;
	side: Side;
	dropKey: string;
	itemId?: number | null;
	itemName?: string | null;
	/** Explicit column — the manual/admin path, where the item is not the deciding factor. */
	col?: number | null;
	byUserId?: string | null;
	receivedAt?: string | null;
}): Promise<ClaimReport> {
	const sb = db();
	const snap = await loadConnect4ById(input.eventId);
	if (!snap) return { status: 'error', error: 'No such game' };
	if (snap.phase !== 'live') return { status: 'not_live', error: 'This game is not running' };
	if (!dropKeyAllowed(snap.test, input.dropKey)) {
		return { status: 'blocked', error: 'This is a test game — it only accepts simulated drops' };
	}
	if (input.receivedAt && snap.startsAt && new Date(input.receivedAt) < new Date(snap.startsAt)) {
		return { status: 'timing', error: 'That drop predates the game' };
	}

	let pieces = snap.pieces;
	const deck = snap.deck;
	if (!deck.length) return { status: 'error', error: 'This game has no deck' };

	// Already credited? Say so plainly rather than reporting whatever the board looks like
	// now — see `claimedBy`.
	const already = pieces.find((p) => p.drop_key === input.dropKey);
	if (already) return duplicateOf(already);

	const size = sizeOf(snap);
	// Whether THIS invocation already banked its progress row — a cell-conflict retry
	// must not re-insert the same drop_key and mistake itself for a duplicate.
	let banked = false;
	for (let attempt = 0; attempt < 4; attempt++) {
		const live = liveTiles(deck, pieces, size);

		// Which column does this claim land in?
		let target: LiveTile | null = null;
		if (input.col != null) {
			target = live[input.col] ?? null;
			if (!target) return { status: 'no_tile', error: 'That column is full' };
		} else {
			target =
				live.find((l): l is LiveTile => !!l && matchesTile({ item_id: input.itemId, item_name: input.itemName }, l.tile)) ??
				null;
			if (!target) {
				// Not on offer — but WAS it, before someone else claimed it? A drop that
				// drains after the winner's is the common shape of a shared-tile race, and
				// it must land `raced` (terminal) like the tight race below: `no_tile`
				// would put it in the reconcile churn for days.
				const winner = racedOutBy(deck, pieces, {
					item_id: input.itemId,
					item_name: input.itemName
				});
				if (winner) return { status: 'raced', error: 'Another player claimed that tile first' };
				return { status: 'no_tile' };
			}
		}

		// QUANTITY tile, drop-driven claim: bank this drop toward the side's count and
		// only let the side's Nth drop through to the piece insert below. An explicit-col
		// claim (creditManual / admin) skips this — an admin crediting a column means the
		// tile is decided, not one more drop toward it. The progress row shares the
		// piece's unique (event_id, drop_key) guard, so the reconcile pass can re-run a
		// counted drop forever and it stays one drop.
		const need = tileQty(target.tile);
		if (input.col == null && need > 1) {
			if (!banked) {
				const { error: pErr } = await sb.from('vs_connect4_progress').insert({
					event_id: input.eventId,
					deck_idx: target.deckIdx,
					side: input.side,
					by_user_id: input.byUserId ?? null,
					item_name: input.itemName ?? null,
					drop_key: input.dropKey
				});
				if (pErr) {
					if ((pErr as { code?: string }).code !== '23505') return { status: 'error', error: pErr.message };
					// Counted on an earlier run (and if it had completed the tile, the piece
					// guard above would already have answered 'duplicate').
					return { status: 'duplicate', col: target.col };
				}
				banked = true;
			}
			const { count } = await sb
				.from('vs_connect4_progress')
				.select('id', { count: 'exact', head: true })
				.eq('event_id', input.eventId)
				.eq('deck_idx', target.deckIdx)
				.eq('side', input.side);
			const have = count ?? 1;
			if (have < need) {
				return { status: 'progress', col: target.col, side: input.side, tile: target.tile, have, need };
			}
			// The Nth drop falls through and claims the piece with the same drop_key.
		}

		const row = landingRow(columnCounts(pieces, size), target.col, size);
		if (row === null) return { status: 'no_tile', error: 'That column is full' };

		const { error } = await sb.from('vs_connect4_pieces').insert({
			event_id: input.eventId,
			col: target.col,
			row,
			side: input.side,
			deck_idx: target.deckIdx,
			item_id: target.tile.item_id,
			item_name: target.tile.item_name,
			source: target.tile.source,
			by_user_id: input.byUserId ?? null,
			drop_key: input.dropKey
		});

		if (error) {
			if ((error as { code?: string }).code !== '23505') {
				return { status: 'error', error: error.message };
			}
			// Already credited — the reconcile pass re-runs recent drops on purpose.
			if (isDropKeyConflict(error)) {
				const mine = await claimedBy(input.eventId, input.dropKey);
				return mine ? duplicateOf(mine) : { status: 'duplicate' };
			}

			// The cell went to someone else. That is usually a genuine race — but it is also
			// what a concurrent re-submission of the SAME drop looks like, since both copies
			// aim at the same cell and Postgres reports whichever index it checked first. Ask
			// who owns this drop key before calling it a loss.
			const mine = await claimedBy(input.eventId, input.dropKey);
			if (mine) return duplicateOf(mine);

			// Re-read and see whether this drop still has a tile to claim; if the column
			// moved to a different item, the race is simply lost.
			pieces = await readPieces(input.eventId);
			if (input.col != null) continue;
			const nowLive = liveTiles(deck, pieces, size);
			const stillMatches = nowLive.some(
				(l) => !!l && matchesTile({ item_id: input.itemId, item_name: input.itemName }, l.tile)
			);
			if (!stillMatches) return { status: 'raced' };
			continue;
		}

		// Landed. Everything reported from here is derived from a fresh read, so a
		// concurrent claim elsewhere on the board is included rather than raced with.
		const after = await readPieces(input.eventId);
		const cell = cellId(target.col, row);
		const scoring = snap.scoring;
		const runs = runsThrough(
			computeRuns(after, scoring),
			cell
		).filter((r) => r.side === input.side);
		const nextLive = liveTiles(deck, after, size);

		await syncTrackedItems(input.eventId, { ...snap, pieces: after, live: nextLive });

		let finished = false;
		if (after.length >= snap.deckSize) {
			finished = true;
			await patchStructure(input.eventId, { phase: 'finished', winner: leaderOf(after, scoring) });
			await sb.from('vs_events').update({ ends_at: new Date().toISOString() }).eq('id', input.eventId);
		}

		return {
			status: 'claimed',
			col: target.col,
			row,
			cell,
			side: input.side,
			tile: target.tile,
			replacement: nextLive[target.col]?.tile ?? null,
			newRuns: runs,
			standings: computeStandings(after, scoring),
			finished
		};
	}
	return { status: 'raced', error: 'Lost the race for that tile' };
}

function computeRuns(pieces: Piece[], scoring: Connect4Scoring): Run[] {
	return computeStandings(pieces, scoring).flatMap((s) => s.runs);
}

/** The admin path: credit a column to a side by hand, no drop involved. */
export async function creditManual(input: {
	eventId: string;
	side: Side;
	col: number;
	byUserId?: string | null;
}): Promise<ClaimReport> {
	return claimTile({
		eventId: input.eventId,
		side: input.side,
		col: input.col,
		dropKey: `manual:${randomUUID()}`,
		byUserId: input.byUserId ?? null
	});
}

// ── The tracked-item projection ─────────────────────────────────────────────

/**
 * Mirror the 25 live tiles into vs_event_tracked_items, which is what branch 1 of
 * vs_active_player_tiles serves to the Dink proxy's allowlist and to the drop consumer's
 * candidate matcher. Diff-based and idempotent, so it is safe to run on every page load —
 * which is exactly how a crash between a claim and its sync heals itself.
 */
export async function syncTrackedItems(
	eventId: string,
	preloaded?: Connect4Snapshot
): Promise<Result<{ added: number; removed: number }>> {
	// Callers that already hold a fresh snapshot pass it in. This runs on every page load
	// and after every claim, and re-reading the whole game each time was a third of the
	// latency on a credit.
	const snap = preloaded ?? (await loadConnect4ById(eventId));
	if (!snap) return errResult('No such game');
	const sb = db();

	// A game that isn't running should track nothing at all. A custom task's synthetic
	// (negative) item_id never leaves the structure: it is projected as NULL so the
	// consumer and the proxy match it by name, the same rule as matchesTile. A GROUP
	// tile projects one row PER QUALIFYING ITEM (all sharing the column's tile_id), so
	// every member reaches the proxy's allowlist and the consumer's matcher.
	interface Want {
		tile_id: string;
		item_id: number | null;
		item_name: string;
		source_name: string | null;
		required_qty: number;
	}
	const wanted = new Map<string, Want>();
	if (snap.phase === 'live') {
		for (const l of snap.live) {
			if (!l) continue;
			const members = l.tile.any_of?.length
				? l.tile.any_of
				: [{ item_id: l.tile.item_id, item_name: l.tile.item_name }];
			for (const m of members) {
				const id = m.item_id != null && m.item_id > 0 ? Number(m.item_id) : null;
				wanted.set(`col:${l.col}|${id ?? ''}|${m.item_name.toLowerCase()}`, {
					tile_id: `col:${l.col}`,
					item_id: id,
					item_name: m.item_name,
					source_name: l.tile.source ?? null,
					required_qty: tileQty(l.tile)
				});
			}
		}
	}

	const { data: existingRows, error } = await sb
		.from('vs_event_tracked_items')
		.select('id, tile_id, item_id, item_name')
		.eq('event_id', eventId);
	if (error) return errResult(error.message);
	const existing = (existingRows ?? []) as { id: string; tile_id: string; item_id: number | null; item_name: string }[];

	// Keyed on (tile_id, item_id, item_name) — null-safe, since a custom tile's stored id
	// is NULL and Number(null) is 0.
	const keyOf = (tileId: string, itemId: number | null | undefined, name: string) =>
		`${tileId}|${itemId == null ? '' : Number(itemId)}|${name.toLowerCase()}`;
	const have = new Set(existing.map((r) => keyOf(r.tile_id, r.item_id, r.item_name)));
	const stale = existing.filter((r) => !wanted.has(keyOf(r.tile_id, r.item_id, r.item_name)));
	const fresh = [...wanted.entries()].filter(([key]) => !have.has(key)).map(([, w]) => w);

	if (stale.length) {
		const { error: dErr } = await sb
			.from('vs_event_tracked_items')
			.delete()
			.in('id', stale.map((r) => r.id));
		if (dErr) return errResult(dErr.message);
	}
	if (fresh.length) {
		const { error: iErr } = await sb.from('vs_event_tracked_items').insert(
			fresh.map((want) => ({
				event_id: eventId,
				tile_id: want.tile_id,
				item_id: want.item_id,
				item_name: want.item_name,
				required_qty: want.required_qty,
				match_type: 'loot',
				source_name: want.source_name
			}))
		);
		if (iErr) return errResult(iErr.message);
	}
	return okResult({ added: fresh.length, removed: stale.length });
}

// ── Undo ────────────────────────────────────────────────────────────────────

/**
 * Remove a piece. Only the TOP of a column can go: taking one from underneath would
 * rewrite where every piece above it landed, and the board is the record of what
 * happened. The score, the live tile and the winner all correct themselves, because none
 * of them is stored.
 *
 * The source is closed too, or the reconcile pass — which deliberately re-runs drops up
 * to three days old — would simply put the piece straight back.
 */
export async function undoClaim(input: { eventId: string; pieceId: string }): Promise<Result<{ cell: string }>> {
	const sb = db();
	const { data: row } = await sb
		.from('vs_connect4_pieces')
		.select('*')
		.eq('id', input.pieceId)
		.eq('event_id', input.eventId)
		.maybeSingle();
	if (!row) return errResult('No such piece');
	const piece = rowToPiece(row as Record<string, unknown>);

	const pieces = await readPieces(input.eventId);
	// Counted directly rather than via columnCounts, which would need the board size.
	const inColumn = pieces.filter((p) => p.col === piece.col).length;
	if (piece.row !== inColumn - 1) {
		return errResult('Only the top piece of a column can be removed');
	}

	const { error } = await sb.from('vs_connect4_pieces').delete().eq('id', input.pieceId);
	if (error) return errResult(error.message);

	// Close the source so it can't be re-credited. A Dink drop is stamped `reverted`, an
	// outcome the reconcile pass does not re-surface; manual and admin claims have no
	// upstream row and need nothing.
	if (piece.drop_key && !/^(manual|admin|test-)/.test(piece.drop_key)) {
		await sb
			.from('vs_dink_drops')
			.update({ outcome: 'reverted', processed: true })
			.eq('drop_key', piece.drop_key);
	}

	// A finished game becomes unfinished if the board is no longer full.
	const snap = await loadConnect4ById(input.eventId);
	if (snap && snap.phase === 'finished' && snap.pieces.length < snap.deckSize) {
		await patchStructure(input.eventId, { phase: 'live', winner: null });
		await sb.from('vs_events').update({ ends_at: null }).eq('id', input.eventId);
	}
	await syncTrackedItems(input.eventId);
	return okResult({ cell: cellId(piece.col, piece.row) });
}

// ── Ending ──────────────────────────────────────────────────────────────────

export async function finishGame(eventId: string): Promise<Result<{ winner: Side | null }>> {
	const snap = await loadConnect4ById(eventId);
	if (!snap) return errResult('No such game');
	if (snap.phase === 'setup') return errResult('This game has not started');
	const winner = leaderOf(snap.pieces, snap.scoring);
	const res = await patchStructure(eventId, { phase: 'finished', winner });
	if (!res.ok) return errResult(res.error);
	await db().from('vs_events').update({ ends_at: new Date().toISOString() }).eq('id', eventId);
	// Stop tracking: a finished game should not keep items in the proxy's allowlist.
	await syncTrackedItems(eventId);
	return okResult({ winner });
}

export async function reopenGame(eventId: string): Promise<Result> {
	const snap = await loadConnect4ById(eventId);
	if (!snap) return errResult('No such game');
	if (snap.phase !== 'finished') return errResult('This game is not finished');
	const res = await patchStructure(eventId, { phase: 'live', winner: null });
	if (!res.ok) return errResult(res.error);
	await db().from('vs_events').update({ ends_at: null }).eq('id', eventId);
	await syncTrackedItems(eventId);
	return okResult();
}

// ── Listing & deletion ──────────────────────────────────────────────────────

export interface Connect4ListRow {
	id: string;
	slug: string;
	name: string;
	status: string;
	phase: Phase;
	test: boolean;
	pieces: number;
	deckSize: number;
	createdAt: string | null;
}

export async function listConnect4Games(): Promise<Connect4ListRow[]> {
	const sb = db();
	const { data } = await sb
		.from('vs_events')
		.select('id, slug, name, status, structure, created_at')
		.eq('kind', CONNECT4_KIND)
		.order('created_at', { ascending: false });
	const rows = (data ?? []) as {
		id: string;
		slug: string;
		name: string;
		status: string;
		structure: unknown;
		created_at: string | null;
	}[];
	if (!rows.length) return [];

	const { data: counts } = await sb
		.from('vs_connect4_pieces')
		.select('event_id')
		.in('event_id', rows.map((r) => r.id));
	const byEvent = new Map<string, number>();
	for (const c of ((counts ?? []) as { event_id: string }[])) {
		byEvent.set(c.event_id, (byEvent.get(c.event_id) ?? 0) + 1);
	}

	return rows.map((r) => {
		const c4 = readStructure(r.structure);
		return {
			id: r.id,
			slug: r.slug,
			name: r.name,
			status: r.status,
			phase: c4.phase ?? 'setup',
			test: c4.test ?? false,
			deckSize: deckSizeOf(clampSize(c4.size)),
			pieces: byEvent.get(r.id) ?? 0,
			createdAt: r.created_at ?? null
		};
	});
}

/** Test games only — a real event is never deleted from a button. */
export async function deleteConnect4(eventId: string): Promise<Result> {
	const snap = await loadConnect4ById(eventId);
	if (!snap) return errResult('No such game');
	if (!snap.test) return errResult('Only a test game can be deleted here');
	const sb = db();
	// The drops that credited this game go with it — the FK would only null event_id,
	// leaving orphaned "credited" rows in /admin/dink-drops after every e2e/sim run.
	await sb.from('vs_dink_drops').delete().eq('event_id', eventId);
	await sb.from('vs_connect4_progress').delete().eq('event_id', eventId);
	await sb.from('vs_event_tracked_items').delete().eq('event_id', eventId);
	await sb.from('vs_connect4_pieces').delete().eq('event_id', eventId);
	await sb.from('vs_event_signups').delete().eq('event_id', eventId);
	await sb.from('vs_teams').delete().eq('event_id', eventId);
	const { error } = await sb.from('vs_events').delete().eq('id', eventId);
	return error ? errResult(error.message) : okResult();
}

export { COLS, ROWS, DECK_SIZE };
