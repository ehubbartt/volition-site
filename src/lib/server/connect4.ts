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
import { bustEventCaches } from './microCache';
import {
	COLS,
	DECK_SIZE,
	ROWS,
	cellId,
	clampSize,
	DEFAULT_SCORING,
	NEW_GAME_SIZE,
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
	isSide,
	standings as computeStandings,
	tileQty,
	type BonusTotals,
	type BoardSize,
	type Connect4Scoring,
	type LiveTile,
	type Phase,
	type Piece,
	type PieceStatus,
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

/**
 * A points award that sits BESIDE the board: an admin records a pet (or anything else
 * worth a few points that isn't a tile) and the side's total moves without a piece
 * being placed. `points` is what was actually awarded and is stored, not recomputed —
 * see the note in db/scripts/connect4.sql.
 */
export interface BonusAward {
	id: string;
	side: Side;
	points: number;
	kind: string;
	itemName: string | null;
	byUserId: string | null;
	byRsn: string | null;
	note: string | null;
	createdAt: string;
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
	/** Board dimensions, fixed at creation. A new game is 40×15. */
	cols: number;
	rows: number;
	/** cols × rows — how many tiles the pool needs and the board can hold. */
	deckSize: number;
	startsAt: string | null;
	/** The signup event this roster was seated from, if any — see `source_event_id`. */
	sourceEventId: string | null;
	/** Hidden from /events. True for a game still being built, and for test games. */
	unlisted: boolean;
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
	/** Hand-recorded awards (pets) that add to a side's total without touching the board. */
	bonus: BonusAward[];
	/** Tiles waiting to be dealt back in after a full rejection, oldest first. */
	requeue: TileRef[];
	/** Slot → the tile now sitting there, where the requeue has moved one. */
	assignments: Record<string, TileRef>;
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
	/**
	 * Tiles waiting to be dealt back in, oldest first. A fully-rejected tile joins the
	 * back and the freed slot takes the front — a swap, so the board keeps exactly one
	 * tile per cell.
	 */
	requeue?: TileRef[];
	/** Slot → the tile now sitting there, when the requeue has moved one. */
	assignments?: Record<string, TileRef>;
	/**
	 * The signup event this game's roster was seated from, remembered so the two behave as
	 * one event: the board inherits that form's start time, and late signups can be pulled
	 * in right up to the off. Set by `seatByClan`; null for a game seated by hand.
	 */
	source_event_id?: string | null;
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
		claimed_at: r.claimed_at as string,
		// Rows written before the status column existed are settled history.
		status: (r.status as PieceStatus | null) ?? 'confirmed',
		submission_id: (r.submission_id as string | null) ?? null
	};
}

async function readPieces(eventId: string): Promise<Piece[]> {
	// PAGED. The board IS this list — a truncated read would silently show a partial
	// board and mis-score it, which is exactly the shape of limit bug that bit the
	// DuoWolf progress. A 40x15 board is 600 pieces, comfortably under any default cap
	// today; paging costs an extra request only when it is actually needed.
	const { data } = await fetchAllFiltered<Record<string, unknown>>((from, to) =>
		db()
			.from('vs_connect4_pieces')
			.select('*')
			.eq('event_id', eventId)
			.order('claimed_at', { ascending: true })
			.range(from, to)
	);
	return (data ?? []).map(rowToPiece);
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
		.select('id, slug, name, description, kind, status, structure, starts_at, ends_at, unlisted')
		.eq('slug', slug)
		.maybeSingle();
	if (!ev || ev.kind !== CONNECT4_KIND) return null;
	return buildSnapshot(ev as EventRow);
}

export async function loadConnect4ById(eventId: string): Promise<Connect4Snapshot | null> {
	const { data: ev } = await db()
		.from('vs_events')
		.select('id, slug, name, description, kind, status, structure, starts_at, ends_at, unlisted')
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
	unlisted: boolean | null;
}

interface BonusRow {
	id: string;
	side: number;
	points: number;
	kind: string | null;
	item_name: string | null;
	by_user_id: string | null;
	note: string | null;
	created_at: string;
}

async function readBonus(eventId: string): Promise<BonusRow[]> {
	// PAGED: awards are hand-entered so the count is small in practice, but nothing
	// bounds it the way the board bounds pieces, and a truncated read would quietly
	// under-report a side's total.
	const { data } = await fetchAllFiltered<BonusRow>((from, to) =>
		db()
			.from('vs_connect4_bonus')
			.select('id, side, points, kind, item_name, by_user_id, note, created_at')
			.eq('event_id', eventId)
			.order('created_at', { ascending: false })
			.range(from, to)
	);
	return data ?? [];
}

/** Fold award rows into the per-side totals the rules add to each standing. */
function bonusTotals(rows: { side: number; points: number }[]): BonusTotals {
	const out: BonusTotals = {};
	for (const r of rows) {
		if (!isSide(r.side)) continue;
		out[r.side] = (out[r.side] ?? 0) + (Number(r.points) || 0);
	}
	return out;
}

/** The per-side bonus totals for an event, for paths that don't hold a snapshot. */
async function bonusTotalsFor(eventId: string): Promise<BonusTotals> {
	return bonusTotals(await readBonus(eventId));
}

async function buildSnapshot(ev: EventRow): Promise<Connect4Snapshot> {
	const sb = db();
	const c4 = readStructure(ev.structure);

	const [{ data: signupRows }, pieces, bonusRows] = await Promise.all([
		// PAGED: 120v120 is 240 rows today, but a truncated roster would drop players
		// off their side — they would silently stop being able to claim.
		fetchAllFiltered<{ user_id: string; team_id: string | null }>((from, to) =>
			sb.from('vs_event_signups').select('user_id, team_id').eq('event_id', ev.id).range(from, to)
		),
		readPieces(ev.id),
		readBonus(ev.id)
	]);
	const signups = signupRows ?? [];

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
	// The dealt deck, with any requeue swaps overlaid. Applied HERE so every consumer —
	// liveTiles, claimTile, the rail, the CSV — sees one deck and never has to know a
	// tile was moved. The raw array in `structure` stays the original deal.
	const rawDeck = Array.isArray(c4.deck) ? c4.deck : [];
	const slotAssignments = (c4.assignments ?? {}) as Record<string, TileRef>;
	const deck = Object.keys(slotAssignments).length
		? rawDeck.map((t, i) => slotAssignments[String(i)] ?? t)
		: rawDeck;
	const phase: Phase = c4.phase ?? 'setup';

	// Per-side progress toward quantity tiles, attached to the live slots. One extra
	// query, and only for games that actually deal a qty tile.
	const live = deck.length ? liveTiles(deck, pieces, size) : new Array(size.cols).fill(null);
	if (deck.some((t) => tileQty(t) > 1)) {
		const idxs = live.filter((l): l is LiveTile => !!l && tileQty(l.tile) > 1).map((l) => l.deckIdx);
		if (idxs.length) {
			let prog: { deck_idx: number; side: Side; qty?: number }[] | null = null;
			let progErr: unknown = null;
			({ data: prog, error: progErr } = await sb
				.from('vs_connect4_progress')
				.select('deck_idx, side, qty')
				.eq('event_id', ev.id)
				.in('deck_idx', idxs));
			if (missingColumn(progErr)) {
				({ data: prog } = await sb
					.from('vs_connect4_progress')
					.select('deck_idx, side')
					.eq('event_id', ev.id)
					.in('deck_idx', idxs));
			}
			const counts = new Map<number, { 1: number; 2: number }>();
			for (const r of prog ?? []) {
				const c = counts.get(r.deck_idx) ?? { 1: 0, 2: 0 };
				c[r.side] += Number(r.qty) || 1;
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
		sourceEventId: c4.source_event_id ?? null,
		unlisted: ev.unlisted !== false,
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
		requeue: Array.isArray(c4.requeue) ? c4.requeue : [],
		assignments: (c4.assignments ?? {}) as Record<string, TileRef>,
		bonus: bonusRows.map((b) => ({
			id: b.id,
			side: (isSide(b.side) ? b.side : 1) as Side,
			points: Number(b.points) || 0,
			kind: b.kind ?? 'pet',
			itemName: b.item_name,
			byUserId: b.by_user_id,
			byRsn: b.by_user_id ? (usersById.get(b.by_user_id)?.rsn ?? null) : null,
			note: b.note,
			createdAt: b.created_at
		})),
		standings: computeStandings(pieces, scoring, bonusTotals(bonusRows)),
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
	// Before the start, the tiles ON OFFER go too. Hiding them in the markup would not do:
	// the payload is JSON a member can read, and a board dealt the night before would hand
	// whoever opened devtools a list of 40 bosses to be standing at when the clock strikes.
	const live = hasOpened(snap) ? snap.live : snap.live.map(() => null);
	return { ...snap, deck: [], pool: [], custom: [], live };
}

// ── Create & configure ──────────────────────────────────────────────────────

export async function createConnect4(input: {
	slug: string;
	name: string;
	description?: string | null;
	ownerUserId: string;
	scoring?: Partial<Connect4Scoring>;
	sideNames?: [string, string];
	/** Board dimensions — clamped to sane bounds; omitted = `NEW_GAME_SIZE` (40×15). */
	cols?: number;
	rows?: number;
	test?: boolean;
}): Promise<Result<{ id: string; slug: string }>> {
	const sb = db();
	const names = input.sideNames ?? (DEFAULT_SIDE_NAMES as [string, string]);

	const connect4: StructureC4 = {
		phase: 'setup',
		test: input.test ?? false,
		// `normalizeScoring` defaults a MISSING line_mode to the legacy 'tiers' rule so a
		// game stored before the dial existed is never restated. A brand-new game has no
		// history to protect, so it starts from the current defaults instead — otherwise a
		// fresh board would quietly score long runs the old way.
		scoring: normalizeScoring({ ...DEFAULT_SCORING, ...(input.scoring ?? {}) }),
		// `clampSize` falls back to DEFAULT_SIZE, which is the LEGACY size for boards that
		// never stored one. A brand-new game wants the current default instead.
		size: clampSize({
			cols: input.cols ?? NEW_GAME_SIZE.cols,
			rows: input.rows ?? NEW_GAME_SIZE.rows
		}),
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
/**
 * Replace the game's whole tile list from an imported plan: the custom tiles AND the
 * pool in ONE structure write, because 244 separate calls would be 244 round trips and
 * a half-built board if one of them failed.
 *
 * Deliberately all-or-nothing on the cell count: a pool that does not fill the board
 * exactly is refused with the arithmetic spelled out, since the likely fix is the board
 * size rather than the plan.
 */
export async function importPool(
	eventId: string,
	custom: TileRef[],
	pool: TileRef[]
): Promise<Result<{ tiles: number; cells: number }>> {
	const snap = await loadConnect4ById(eventId);
	if (!snap) return errResult('No such game');
	if (snap.phase !== 'setup') return errResult('The pool is locked once the game starts');
	if (pool.length !== snap.deckSize) {
		const size = `${snap.cols}x${snap.rows}`;
		return errResult(
			`That plan fills ${pool.length} cells but this board has ${snap.deckSize} (${size}). ` +
				`Change the board size on a new game, or adjust the copies in the plan.`
		);
	}
	const res = await patchStructure(eventId, { custom, pool });
	return res.ok ? okResult({ tiles: custom.length, cells: pool.length }) : errResult(res.error);
}

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
/** One row of the admin roster panel: who they are, where they sit, and whether they play. */
export interface RosterRow {
	id: string;
	rsn: string | null;
	side: Side | null;
	inEvent: boolean;
}

/**
 * WHO THE ADMIN ROSTER PANEL MAY ACT ON — every site account, plus anyone this game has
 * on it whose account the first list misses.
 *
 * That second half is the whole point. The account list only holds users with an RSN, so
 * a player seated with a blank one (an opposing-clan member part-way through onboarding,
 * or someone whose RSN was cleared when they left the clan) was on a side and yet absent
 * from the panel — impossible to tick, so impossible to remove. A member the game knows
 * about must always be reachable from the screen that takes members off it.
 *
 * Lives here rather than in the page loader so it can be driven by
 * `npm run drill:connect4:roster` without a browser.
 */
export async function rosterFor(game: Connect4Snapshot): Promise<RosterRow[]> {
	// Paged: the roster is well past PostgREST's 1000-row cap at clan scale.
	const users = await fetchAllFiltered<{ id: string; rsn: string | null }>((from, to) =>
		db().from('vs_users').select('id, rsn').not('rsn', 'is', null).order('rsn').range(from, to)
	);

	const sideByUser = new Map<string, Side>();
	for (const s of game.sides) for (const m of s.members) sideByUser.set(m.userId, s.side);
	// Signed up but on no side is a real state, and it used to look exactly like "not in
	// this event at all" — so removing such a member changed nothing on screen.
	const inEvent = new Set<string>([...sideByUser.keys(), ...game.unassigned.map((u) => u.userId)]);

	const known = new Set((users.data ?? []).map((u) => u.id));
	const strays = [...game.sides.flatMap((s) => s.members), ...game.unassigned]
		.filter((m) => !known.has(m.userId))
		.map((m) => ({ id: m.userId, rsn: m.rsn }));

	return [...(users.data ?? []), ...strays]
		.map((u) => ({
			id: u.id,
			rsn: u.rsn,
			side: sideByUser.get(u.id) ?? null,
			inEvent: inEvent.has(u.id)
		}))
		.sort((a, b) => (a.rsn ?? '\uffff').localeCompare(b.rsn ?? '\uffff'));
}

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
 * Take members OFF the event entirely — the signup row goes, not just the side.
 *
 * Distinct from `assignSides(null)`, which unseats but leaves them enrolled: that state
 * is invisible on the roster (no side pill either way), so an admin clicking a button
 * labelled "Remove" on someone who is already unseated saw nothing change and nothing
 * leave. Pieces they already claimed stay on the board — those are the game's record and
 * are attributed by `by_user_id`, which this does not touch.
 */
export async function removeFromEvent(input: {
	eventId: string;
	userIds: string[];
}): Promise<Result<{ removed: number }>> {
	if (!input.userIds.length) return okResult({ removed: 0 });
	const { data, error } = await db()
		.from('vs_event_signups')
		.delete()
		.eq('event_id', input.eventId)
		.in('user_id', input.userIds)
		.select('user_id');
	if (error) return errResult(error.message);
	return okResult({ removed: (data ?? []).length });
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
	// Remember where this roster came from. From here the two behave as one event: the
	// board takes its start time from that form, and anyone who signs up between now and
	// the off can be pulled in with the same button.
	if (input.sourceEventId && input.sourceEventId !== input.eventId) {
		await patchStructure(input.eventId, { source_event_id: input.sourceEventId });
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
/**
 * Is the game open for play? A dealt game whose `startsAt` is still in the future is
 * LIVE but not yet OPEN: the deck is dealt and the roster is settled, and nothing counts
 * until the clock says so. That gap is what lets an admin set a board up the night before
 * an announced start without handing anyone a head start.
 */
/** The `starts_at` of the signup event a game was seated from, if it has one. */
export async function sourceStart(sourceEventId: string): Promise<string | null> {
	const { data } = await db()
		.from('vs_events')
		.select('starts_at')
		.eq('id', sourceEventId)
		.maybeSingle();
	return ((data as { starts_at: string | null } | null)?.starts_at) ?? null;
}

/** True when an error says a column is not there yet — a hand-applied migration pending. */
function missingColumn(e: unknown): boolean {
	const code = (e as { code?: string } | null)?.code;
	return code === '42703' || code === 'PGRST204';
}

export function hasOpened(snap: { phase: Phase; startsAt: string | null }, now = Date.now()): boolean {
	if (snap.phase !== 'live') return false;
	if (!snap.startsAt) return true;
	const t = new Date(snap.startsAt).getTime();
	return !isFinite(t) || t <= now;
}

/**
 * Deal the deck and put the game live.
 *
 * `startsAt` is the moment the race actually begins — the cutoff a drop has to beat, and
 * the instant the board opens. It defaults to now (deal and go), but an event announced
 * for a set time should pass that time instead: the deck can then be dealt whenever, and
 * both clans still see the tiles for the first time at the same second.
 */
export async function startGame(
	eventId: string,
	seed?: number,
	startsAt?: string | Date | null
): Promise<Result<{ seed: number }>> {
	const snap = await loadConnect4ById(eventId);
	if (!snap) return errResult('No such game');
	if (snap.phase !== 'setup') return errResult('This game has already started');
	if (snap.pool.length !== snap.deckSize) return errResult(`Curate ${snap.deckSize} tiles first`);
	const anyMembers = snap.sides.some((s) => s.members.length > 0);
	if (!anyMembers) return errResult('Put at least one member on a side first');

	// An unreadable date is refused rather than quietly becoming "now": silently starting
	// a scheduled event immediately is the one failure here nobody could undo.
	let openAt = new Date();
	if (startsAt) {
		openAt = startsAt instanceof Date ? startsAt : new Date(startsAt);
		if (!isFinite(openAt.getTime())) return errResult('That start time is not a real date');
	} else if (snap.sourceEventId) {
		// Seated from a signup form and given no time of its own: the board starts when that
		// form says the event starts. This is what makes the two feel like ONE event — the
		// deck can be dealt the night before and the race still begins when it was announced.
		const inherited = await sourceStart(snap.sourceEventId);
		if (inherited) openAt = new Date(inherited);
	}

	const usedSeed = seed ?? Math.floor(Math.random() * 2 ** 31);
	const deck = shuffleDeck(snap.pool, seededRandom(usedSeed));

	const sb = db();
	const { data: cur } = await sb.from('vs_events').select('structure').eq('id', eventId).maybeSingle();
	const structure = (cur?.structure ?? {}) as Record<string, unknown>;
	const c4 = { ...readStructure(structure), phase: 'live' as Phase, deck, seed: usedSeed };

	const { data: updated, error } = await sb
		.from('vs_events')
		.update({
			structure: { ...structure, connect4: c4 },
			status: 'open',
			starts_at: openAt.toISOString(),
			// A game is created UNLISTED so a half-built board never shows up on /events.
			// Starting it is the moment that stops being true — and nothing else ever cleared
			// the flag, so a real game could be live, open and still invisible to the clan.
			// Test games stay hidden: they are rehearsals, not events.
			unlisted: snap.test
		})
		.eq('id', eventId)
		// The CAS: only the row still in `setup` is updated, so a second Start deals nothing.
		.eq('structure->connect4->>phase', 'setup')
		.select('id');
	if (error) return errResult(error.message);
	if (!updated?.length) return errResult('This game has already started');

	// The events list is micro-cached, and starting a game changes what belongs on it.
	bustEventCaches();
	await syncTrackedItems(eventId);
	return okResult({ seed: usedSeed });
}

/**
 * Show or hide the game on /events. Separate from `status` — an event can be `open` and
 * still `unlisted`, which is the state a Connect Four game used to be stuck in.
 */
export async function setListed(eventId: string, listed: boolean): Promise<Result> {
	const { error } = await db().from('vs_events').update({ unlisted: !listed }).eq('id', eventId);
	if (error) return errResult(error.message);
	bustEventCaches();
	return okResult();
}

/**
 * STAMP THE PRE-SCREENSHOT FLAG ONTO AN ALREADY-DEALT GAME.
 *
 * The flag lives on the tile, and a live game's tiles are a copy taken at deal time — so
 * updating the checked-in planned list does nothing for a board that is already dealt.
 * This matches by NAME across every place a tile is held (pool, custom, deck, requeue and
 * the assignment overlay) and sets the flag there, touching nothing else: no re-deal, no
 * re-shuffle, no change to which tile sits above which column. Safe to run on a game with
 * pieces already on it, and safe to run twice.
 */
export async function applyPreShots(
	eventId: string,
	names: { name: string; note?: string | null }[]
): Promise<Result<{ tiles: number; cells: number }>> {
	const norm = (v: string) => v.toLowerCase().replace(/[^a-z0-9]/g, '');
	const want = new Map(names.map((n) => [norm(n.name), n.note ?? null]));
	if (!want.size) return errResult('No tiles given');

	const sb = db();
	const { data, error } = await sb.from('vs_events').select('structure').eq('id', eventId).maybeSingle();
	if (error) return errResult(error.message);
	const structure = (data?.structure ?? {}) as Record<string, unknown>;
	const c4 = readStructure(structure);

	let cells = 0;
	const seen = new Set<string>();
	const stamp = (t: TileRef): TileRef => {
		const key = norm(t.item_name ?? '');
		if (!want.has(key)) return t;
		seen.add(key);
		const note = want.get(key);
		return { ...t, pre_shot: true, ...(note ? { pre_note: note } : {}) };
	};

	const pool = (c4.pool ?? []).map(stamp);
	const custom = (c4.custom ?? []).map(stamp);
	const deck = (c4.deck ?? []).map((t) => {
		const next = stamp(t);
		if (next.pre_shot) cells++;
		return next;
	});
	const requeue = (c4.requeue ?? []).map(stamp);
	const assignments = Object.fromEntries(
		Object.entries(c4.assignments ?? {}).map(([k, t]) => [k, stamp(t)])
	);

	const patched = await patchStructure(eventId, { pool, custom, deck, requeue, assignments });
	if (!patched.ok) return errResult(patched.error);
	return okResult({ tiles: seen.size, cells });
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
	/**
	 * 'pending' places the piece PROVISIONALLY — it holds the cell (so submission order,
	 * not review order, settles who won the tile) but is shown unconfirmed until a
	 * reviewer approves it. Admin credits have nothing to review and stay 'confirmed'.
	 */
	status?: PieceStatus;
	/** The vs_submissions row that placed it, so a decision can find its piece. */
	submissionId?: string | null;
	/**
	 * An ADMIN deciding the tile outright, rather than one more drop toward it. Only this
	 * skips the quantity gate: a ×N tile otherwise needs N qualifying drops from one side
	 * however the claim arrived.
	 */
	adminCredit?: boolean;
	/** How many qualifying drops this one claim covers — a ×N tile banks that many. */
	covers?: number;
}): Promise<ClaimReport> {
	const sb = db();
	const snap = await loadConnect4ById(input.eventId);
	if (!snap) return { status: 'error', error: 'No such game' };
	if (snap.phase !== 'live') return { status: 'not_live', error: 'This game is not running' };
	if (!dropKeyAllowed(snap.test, input.dropKey)) {
		return { status: 'blocked', error: 'This is a test game — it only accepts simulated drops' };
	}
	if (!hasOpened(snap)) {
		return { status: 'not_live', error: `This game opens at ${snap.startsAt}` };
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

		// QUANTITY tile: bank this claim toward the side's count and only let the claim that
		// REACHES N through to the piece insert below.
		//
		// This used to be gated on `input.col == null`, i.e. "only the drop pipeline
		// counts" — on the reasoning that naming a column meant an admin deciding the tile.
		// That stopped being true the moment members began claiming by column with manual
		// proof: a single submission against a ×1000 tile named its column, skipped the
		// gate entirely, and completed the tile on one drop. The gate now turns on WHO is
		// claiming. Only an explicit admin credit decides a tile outright.
		//
		// The progress row shares the piece's unique (event_id, drop_key) guard, so the
		// reconcile pass can re-run a counted drop forever and it stays one drop.
		const need = tileQty(target.tile);
		if (!input.adminCredit && need > 1) {
			if (!banked) {
				// ONE row carrying the AMOUNT this claim covers, not a row per unit: a tile can
				// ask for 70,000 points, and banking a row each would be absurd. The row keeps
				// the same unique (event_id, drop_key) guard, so a re-run still counts once.
				const covers = Math.max(1, Math.min(need, Math.round(Number(input.covers) || 1)));
				const row = {
					event_id: input.eventId,
					deck_idx: target.deckIdx,
					side: input.side,
					by_user_id: input.byUserId ?? null,
					item_name: input.itemName ?? null,
					drop_key: input.dropKey
				};
				let { error: pErr } = await sb.from('vs_connect4_progress').insert({ ...row, qty: covers });
				// `qty` arrives with a hand-applied migration. Until it is on a given database
				// this falls back to the old one-row-per-claim shape rather than failing the
				// claim — on event day a missing column must not stop anyone submitting.
				// PostgREST names the same problem differently on a write (PGRST204, from its
				// schema cache) than on a read (42703, straight from Postgres).
				if (missingColumn(pErr)) {
					({ error: pErr } = await sb.from('vs_connect4_progress').insert(row));
				}
				if (pErr) {
					if ((pErr as { code?: string }).code !== '23505') return { status: 'error', error: pErr.message };
					// Counted on an earlier run (and if it had completed the tile, the piece
					// guard above would already have answered 'duplicate').
					return { status: 'duplicate', col: target.col };
				}
				banked = true;
			}
			let banks: { qty?: number }[] | null = null;
			let bErr: unknown = null;
			({ data: banks, error: bErr } = await sb
				.from('vs_connect4_progress')
				.select('qty')
				.eq('event_id', input.eventId)
				.eq('deck_idx', target.deckIdx)
				.eq('side', input.side));
			if (missingColumn(bErr)) {
				const legacy = await sb
					.from('vs_connect4_progress')
					.select('id')
					.eq('event_id', input.eventId)
					.eq('deck_idx', target.deckIdx)
					.eq('side', input.side);
				// Pre-migration rows are worth one each, which is what they always meant.
				banks = (legacy.data ?? []).map(() => ({ qty: 1 }));
			}
			// SUM, not COUNT: one row can carry a whole screenshot's worth.
			const have = (banks ?? []).reduce((n, r) => n + (Number(r.qty) || 1), 0) || 1;
			if (have < need) {
				return { status: 'progress', col: target.col, side: input.side, tile: target.tile, have, need };
			}
			// The Nth drop falls through and claims the piece with the same drop_key.
		}

		const row = landingRow(columnCounts(pieces, size), target.col, size);
		if (row === null) return { status: 'no_tile', error: 'That column is full' };

		const base = {
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
		};
		let { error } = await sb.from('vs_connect4_pieces').insert({
			...base,
			status: input.status ?? 'confirmed',
			submission_id: input.submissionId ?? null
		});
		// Schema here is hand-applied, so the code can reach a database that has not had
		// the provisional-piece columns yet. Rather than fail every claim until someone
		// runs the SQL, fall back to the shape that always existed: the piece lands, it
		// is simply confirmed on the spot and cannot be reviewed. `42703`/`PGRST204` are
		// "no such column" from Postgres and PostgREST respectively.
		if (error && /42703|PGRST204/.test(`${(error as { code?: string }).code} ${error.message}`)) {
			console.warn('[connect4] pieces table has no status column — run connect4.sql');
			({ error } = await sb.from('vs_connect4_pieces').insert(base));
		}

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

		// Bonus awards count toward the total, so they decide the winner too — read them
		// once for both the auto-finish verdict and the report's standings.
		const bonus = await bonusTotalsFor(input.eventId);

		let finished = false;
		if (after.length >= snap.deckSize) {
			finished = true;
			await patchStructure(input.eventId, {
				phase: 'finished',
				winner: leaderOf(after, scoring, bonus)
			});
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
			standings: computeStandings(after, scoring, bonus),
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
		byUserId: input.byUserId ?? null,
		// An admin crediting a column means the tile is decided, not one more drop toward
		// it — the one case that skips the quantity gate.
		adminCredit: true
	});
}

// ── The tracked-item projection ─────────────────────────────────────────────

/**
 * Mirror the 25 live tiles into vs_event_tracked_items, which is what branch 1 of
 * vs_active_player_tiles serves to the Dink proxy's allowlist and to the drop consumer's
 * candidate matcher. Diff-based and idempotent, so it is safe to run on every page load —
 * which is exactly how a crash between a claim and its sync heals itself.
 */
/**
 * Whether a live game projects its tiles into the Dink allowlist.
 *
 * OFF for the clan-vs-clan event, deliberately: only one of the two clans had Dink set
 * up, so auto-crediting was a head start rather than a convenience. With this false a
 * game tracks NOTHING — no drop can match a tile — and every claim arrives as a proof
 * submission reviewed in /admin/submissions.
 *
 * Flipping it back to true is the whole restore: the projection, the proxy allowlist
 * and the drop consumer are all unchanged and still work.
 */
const DINK_AUTO_TRACKING = false;

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
	if (DINK_AUTO_TRACKING && snap.phase === 'live') {
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
	const winner = leaderOf(snap.pieces, snap.scoring, bonusTotals(snap.bonus));
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
/**
 * Record a bonus award (a pet, by default). Deliberately NOT a claim: nothing is dealt,
 * no cell is consumed and the board is untouched — only the side's total moves. Allowed
 * while the game is live or finished, so a pet that lands minutes before the end can
 * still be honoured after the final piece.
 */
export async function addBonus(input: {
	eventId: string;
	side: Side;
	points: number;
	kind?: string;
	itemName?: string | null;
	byUserId?: string | null;
	note?: string | null;
	awardedBy?: string | null;
}): Promise<Result<{ id: string }>> {
	const snap = await loadConnect4ById(input.eventId);
	if (!snap) return errResult('No such game');
	if (snap.phase === 'setup') return errResult('Start the game before awarding bonus points');
	if (!isSide(input.side)) return errResult('Pick a side');
	const points = Math.round(Number(input.points));
	if (!isFinite(points) || points === 0) return errResult('Give the award a non-zero point value');
	if (Math.abs(points) > 100_000) return errResult('That is not a bonus, that is a rewrite');

	const name = (input.itemName ?? '').trim();
	const { data, error } = await db()
		.from('vs_connect4_bonus')
		.insert({
			event_id: input.eventId,
			side: input.side,
			points,
			kind: (input.kind ?? 'pet').trim() || 'pet',
			item_name: name || null,
			by_user_id: input.byUserId || null,
			note: (input.note ?? '').trim() || null,
			awarded_by: input.awardedBy || null
		})
		.select('id')
		.single();
	if (error) return errResult(error.message);
	await restateWinner(snap);
	return okResult({ id: (data as { id: string }).id });
}

/** Take an award back. Scoped to the event so a stale id can't reach another game's row. */
export async function removeBonus(eventId: string, bonusId: string): Promise<Result> {
	const snap = await loadConnect4ById(eventId);
	if (!snap) return errResult('No such game');
	const { error } = await db()
		.from('vs_connect4_bonus')
		.delete()
		.eq('event_id', eventId)
		.eq('id', bonusId);
	if (error) return errResult(error.message);
	await restateWinner(snap);
	return okResult();
}

/**
 * A FINISHED game stores its winner, decided once when it ended — but a bonus award moves
 * the totals, and a pet recorded after the last piece fell can genuinely change who won.
 * Re-decide from the awards as they stand now. No-op while the game is still live, where
 * the winner is not written down yet.
 */
async function restateWinner(snap: Connect4Snapshot): Promise<void> {
	if (snap.phase !== 'finished') return;
	const fresh = await loadConnect4ById(snap.id);
	if (!fresh) return;
	const winner = leaderOf(fresh.pieces, fresh.scoring, bonusTotals(fresh.bonus));
	if (winner !== fresh.winner) await patchStructure(snap.id, { winner });
}

// ── Reviewing a provisional claim ────────────────────────────────────────────

/**
 * A partially-rejected submitter keeps their tile — that IS the priority. When they come
 * back with a better screenshot we point the piece they already hold at the new proof
 * row rather than trying to claim the cell again, which would fail because they are
 * already standing on it.
 *
 * Returns false when they hold nothing there, so the caller knows to claim normally.
 */
/**
 * The caller's own pending piece in a column — the claim they are being asked to
 * re-evidence. Its `deck_idx` is the tile they actually hold, which is NOT the one the
 * column is offering now: their piece took that slot and the column moved on.
 */
export async function pendingPieceOf(
	eventId: string,
	col: number,
	userId: string
): Promise<{ id: string; deck_idx: number; row: number; item_name: string | null } | null> {
	const { data } = await db()
		.from('vs_connect4_pieces')
		.select('id, deck_idx, row, item_name')
		.eq('event_id', eventId)
		.eq('col', col)
		.eq('by_user_id', userId)
		.eq('status', 'pending')
		.limit(1);
	return ((data ?? [])[0] as { id: string; deck_idx: number; row: number; item_name: string | null }) ?? null;
}

export async function repointPendingPiece(
	eventId: string,
	col: number,
	userId: string,
	submissionId: string
): Promise<boolean> {
	const { data } = await db()
		.from('vs_connect4_pieces')
		.select('id')
		.eq('event_id', eventId)
		.eq('col', col)
		.eq('by_user_id', userId)
		.eq('status', 'pending')
		.limit(1);
	const row = (data ?? [])[0] as { id: string } | undefined;
	if (!row) return false;
	await db()
		.from('vs_connect4_pieces')
		.update({ submission_id: submissionId })
		.eq('id', row.id);
	return true;
}


/** Approve: the piece stops being provisional and simply stands. */
export async function confirmPiece(submissionId: string): Promise<Result> {
	const { error } = await db()
		.from('vs_connect4_pieces')
		.update({ status: 'confirmed' })
		.eq('submission_id', submissionId);
	return error ? errResult(error.message) : okResult();
}

/**
 * FULL rejection: the claim is not good and the tile goes back into play.
 *
 * Three things have to happen together, and the order matters:
 *   1. the piece is deleted;
 *   2. every piece ABOVE it in that column shifts down a row — but keeps its own
 *      `deck_idx`, because a player keeps the tile they actually earned. Row and slot
 *      are decoupled from here on, which is exactly what `liveTiles` was generalised
 *      for;
 *   3. the freed tile goes to the BACK of the requeue and the freed slot takes whatever
 *      was at the FRONT of it. That is a swap, so the board still holds exactly one
 *      tile per cell — with an empty queue it is the identity, and the tile simply
 *      becomes its column's live offer again.
 *
 * A partial rejection does none of this: the piece stays exactly where it is, which IS
 * the submitter's priority — they still hold the tile while they find a better shot.
 */
export async function rejectPieceFully(
	eventId: string,
	submissionId: string
): Promise<Result<{ cell: string; requeued: string | null }>> {
	const sb = db();
	const snap = await loadConnect4ById(eventId);
	if (!snap) return errResult('No such game');

	const piece = snap.pieces.find((p) => p.submission_id === submissionId);
	if (!piece) return okResult({ cell: '', requeued: null }); // nothing was placed

	const size = sizeOf(snap);
	const cell = cellId(piece.col, piece.row);

	const { error: delErr } = await sb.from('vs_connect4_pieces').delete().eq('id', piece.id!);
	if (delErr) return errResult(delErr.message);

	// Shift the column down. Sequential on purpose: unique(event_id, col, row) means two
	// rows briefly colliding would be rejected, and walking upward from the hole never
	// collides because the cell below has just been vacated.
	const above = snap.pieces
		.filter((p) => p.col === piece.col && p.row > piece.row)
		.sort((a, b) => a.row - b.row);
	for (const p of above) {
		const { error } = await sb
			.from('vs_connect4_pieces')
			.update({ row: p.row - 1 })
			.eq('id', p.id!);
		if (error) return errResult(`shifting ${cellId(p.col, p.row)}: ${error.message}`);
	}

	// Swap the freed tile through the requeue.
	const queue: TileRef[] = [...snap.requeue];
	const assignments: Record<string, TileRef> = { ...snap.assignments };
	const freedTile = assignments[String(piece.deck_idx)] ?? snap.deck[piece.deck_idx];
	if (freedTile) {
		queue.push(freedTile);
		const incoming = queue.shift()!;
		assignments[String(piece.deck_idx)] = incoming;
	}
	const res = await patchStructure(eventId, { requeue: queue, assignments });
	if (!res.ok) return errResult(res.error);

	return okResult({ cell, requeued: freedTile?.item_name ?? null });
}

export async function deleteConnect4(eventId: string): Promise<Result> {
	const snap = await loadConnect4ById(eventId);
	if (!snap) return errResult('No such game');
	if (!snap.test) return errResult('Only a test game can be deleted here');
	const sb = db();
	// The drops that credited this game go with it — the FK would only null event_id,
	// leaving orphaned "credited" rows in /admin/dink-drops after every e2e/sim run.
	await sb.from('vs_dink_drops').delete().eq('event_id', eventId);
	await sb.from('vs_connect4_progress').delete().eq('event_id', eventId);
	await sb.from('vs_connect4_bonus').delete().eq('event_id', eventId);
	// Claim submissions reference the event too. Without this the FK blocks the delete
	// and a test game can never be cleaned up once anyone has submitted for it.
	await sb.from('vs_submissions').delete().eq('event_id', eventId);
	await sb.from('vs_event_tracked_items').delete().eq('event_id', eventId);
	await sb.from('vs_connect4_pieces').delete().eq('event_id', eventId);
	await sb.from('vs_event_signups').delete().eq('event_id', eventId);
	await sb.from('vs_teams').delete().eq('event_id', eventId);
	const { error } = await sb.from('vs_events').delete().eq('id', eventId);
	return error ? errResult(error.message) : okResult();
}

export { COLS, ROWS, DECK_SIZE };
