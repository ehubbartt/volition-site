// SERVER-ONLY: personal PVM collection-log bingo boards.
//
// A user generates a private N×N grid (N = 3..5) of collection-log items they do NOT
// already own, drawn from the PVM boss/raid clog universe (itemEhb.json) and balanced
// by EHB-to-obtain into an easy→hard gradient scaled by a difficulty dial. Tiles are
// auto-marked "obtained" by re-polling the player's collection log (Temple) and by the
// Dink auto-tracker. One board per user (regenerating replaces it).
//
// LIFECYCLE: a board starts as a DRAFT (locked_at = null) — the owner can reroll it as
// many times as they like and it is NOT tracked. LOCKING it (sets locked_at) starts
// progress tracking and commits the board for LOCK_DAYS; only after that window can it be
// reset and regenerated.

import { db } from './db';
import { fetchTempleCollectionLog } from './rankData';
import { bestEhbSource, type ItemEhb } from '$lib/ehb';
import itemEhbData from './data/itemEhb.json';

const ITEM_EHB = itemEhbData as ItemEhb[];

export const MIN_SIZE = 3;
export const MAX_SIZE = 5;
export const MIN_DIFFICULTY = 1;
export const MAX_DIFFICULTY = 10;

// A locked board is committed for this long before the owner can reset and make a new one.
export const LOCK_DAYS = 30;
const LOCK_MS = LOCK_DAYS * 24 * 60 * 60 * 1000;

// When a locked board can be reset (null while it's still a draft).
export function boardResettableAt(lockedAt: string | null): string | null {
	return lockedAt ? new Date(new Date(lockedAt).getTime() + LOCK_MS).toISOString() : null;
}

export interface PersonalBoardTile {
	idx: number;
	item_id: number;
	item_name: string;
	ehb: number;
	source: string; // boss/raid the EHB is costed from (cheapest source)
	obtained: boolean;
	obtained_at: string | null;
}

export interface PersonalBoard {
	id: string;
	size: number;
	difficulty: number;
	rsn: string;
	created_at: string;
	locked_at: string | null; // null = draft (reroll freely, not tracked)
	tiles: PersonalBoardTile[];
}

// Flatten the Temple collection-log response into a lowercased set of OWNED item
// names. Temple returns only the slots the player has unlocked (per category), so a
// name's presence = owned. Returns null if the clog couldn't be read.
async function fetchOwnedClogNames(rsn: string): Promise<Set<string> | null> {
	const temple = await fetchTempleCollectionLog(rsn);
	if (!temple) return null;
	const owned = new Set<string>();
	for (const category of Object.values(temple.items)) {
		if (!Array.isArray(category)) continue;
		for (const item of category as { name?: string; count?: number }[]) {
			if (item?.name && Number(item.count ?? 1) > 0) owned.add(item.name.toLowerCase());
		}
	}
	return owned;
}

// Short-lived per-user cache of the owned-clog set so a member can REROLL a draft board
// many times in a row without hammering Temple — each reroll just reshuffles the same
// missing pool. `force` (used by the explicit "Check collection log" refresh) bypasses it
// and refreshes the cache.
const ownedCache = new Map<string, { at: number; owned: Set<string> }>();
const OWNED_TTL_MS = 5 * 60 * 1000;

async function getOwnedClogNames(userId: string, rsn: string, force = false): Promise<Set<string> | null> {
	if (!force) {
		const hit = ownedCache.get(userId);
		if (hit && Date.now() - hit.at < OWNED_TTL_MS) return hit.owned;
	}
	const owned = await fetchOwnedClogNames(rsn);
	if (owned) ownedCache.set(userId, { at: Date.now(), owned });
	return owned;
}

interface Candidate {
	item_id: number;
	item_name: string;
	ehb: number;
	source: string;
}

// All PVM clog items the player is MISSING, each costed at its cheapest EHB source,
// sorted easy→hard.
function missingCandidates(owned: Set<string>): Candidate[] {
	const out: Candidate[] = [];
	for (const item of ITEM_EHB) {
		if (owned.has(item.name.toLowerCase())) continue; // already have it
		const best = bestEhbSource(item);
		if (!best) continue; // no computable EHB source
		out.push({ item_id: item.id, item_name: item.name, ehb: best.ehb, source: best.src.s });
	}
	out.sort((a, b) => a.ehb - b.ehb);
	return out;
}

// Pick N tiles as an easy→hard GRADIENT scaled by difficulty. Difficulty raises the
// EHB ceiling (how rare the hardest tiles get); the pool up to that ceiling is split
// into N equal bands and one item is drawn at random from each band, so every board
// runs from quick tiles up to grindy ones, with variety on each regenerate.
function selectGradient(pool: Candidate[], count: number, difficulty: number): Candidate[] {
	if (pool.length <= count) return pool.slice(); // take everything we have
	const d = Math.min(MAX_DIFFICULTY, Math.max(MIN_DIFFICULTY, difficulty));
	// Ceiling fraction of the (EHB-ascending) pool: difficulty 1 → easiest ~25%,
	// difficulty 10 → the full pool. Always leaves at least `count` items to band.
	const frac = 0.25 + (0.75 * (d - MIN_DIFFICULTY)) / (MAX_DIFFICULTY - MIN_DIFFICULTY);
	const ceiling = Math.max(count, Math.round(pool.length * frac));
	const window = pool.slice(0, ceiling);
	const picked: Candidate[] = [];
	const used = new Set<number>();
	for (let i = 0; i < count; i++) {
		const lo = Math.floor((i * window.length) / count);
		const hi = Math.max(lo + 1, Math.floor(((i + 1) * window.length) / count));
		// random item within this band that we haven't already taken
		let choice = lo;
		for (let tries = 0; tries < 8; tries++) {
			const c = lo + Math.floor(Math.random() * (hi - lo));
			if (!used.has(c)) {
				choice = c;
				break;
			}
			choice = c;
		}
		used.add(choice);
		picked.push(window[Math.min(choice, window.length - 1)]);
	}
	// already ordered easy→hard because bands are ascending (the caller shuffles for layout)
	return picked;
}

// Fisher-Yates in-place shuffle — used so the board's tiles aren't laid out in EHB order.
function shuffle<T>(arr: T[]): void {
	for (let i = arr.length - 1; i > 0; i--) {
		const j = Math.floor(Math.random() * (i + 1));
		[arr[i], arr[j]] = [arr[j], arr[i]];
	}
}

export type GenerateResult =
	| { ok: true; board: PersonalBoard }
	| {
			ok: false;
			reason: 'no_rsn' | 'clog_unavailable' | 'too_few' | 'locked';
			missing?: number;
			need?: number;
			resettable_at?: string;
	  };

// Generate (and persist, replacing any existing) a DRAFT board for the user. Refuses if
// the current board is LOCKED and still inside its commitment window.
export async function generatePersonalBoard(
	userId: string,
	rsn: string | null,
	size: number,
	difficulty: number
): Promise<GenerateResult> {
	if (!rsn) return { ok: false, reason: 'no_rsn' };

	// A locked board can't be rerolled/reset until its commitment window elapses.
	const existing = await loadPersonalBoard(userId);
	if (existing?.locked_at) {
		const reset = boardResettableAt(existing.locked_at);
		if (reset && Date.now() < new Date(reset).getTime()) {
			return { ok: false, reason: 'locked', resettable_at: reset };
		}
	}

	const n = Math.min(MAX_SIZE, Math.max(MIN_SIZE, Math.floor(size)));
	const diff = Math.min(MAX_DIFFICULTY, Math.max(MIN_DIFFICULTY, Math.floor(difficulty)));
	const tileCount = n * n;

	// Cached owned set: rerolling a draft reshuffles without re-hitting Temple each time.
	const owned = await getOwnedClogNames(userId, rsn);
	if (owned == null) return { ok: false, reason: 'clog_unavailable' };

	const pool = missingCandidates(owned);
	if (pool.length < tileCount) {
		return { ok: false, reason: 'too_few', missing: pool.length, need: tileCount };
	}

	const chosen = selectGradient(pool, tileCount, diff);
	// The gradient still spans easy→hard items, but scatter them across the grid so the
	// board isn't sorted by EHB.
	shuffle(chosen);
	const sb = db();

	// One board per user: drop the old one (tiles cascade) before inserting the new draft.
	await sb.from('vs_personal_boards').delete().eq('user_id', userId);

	const { data: boardRow, error: bErr } = await sb
		.from('vs_personal_boards')
		.insert({ user_id: userId, rsn, size: n, difficulty: diff }) // locked_at defaults null = draft
		.select('id, size, difficulty, rsn, created_at, locked_at')
		.single();
	if (bErr || !boardRow) return { ok: false, reason: 'clog_unavailable' };

	const board = boardRow as { id: string; size: number; difficulty: number; rsn: string; created_at: string; locked_at: string | null };
	const tileRows = chosen.map((c, idx) => ({
		board_id: board.id,
		idx,
		item_id: c.item_id,
		item_name: c.item_name,
		ehb: c.ehb,
		source: c.source,
		obtained: false
	}));
	const { error: tErr } = await sb.from('vs_personal_board_tiles').insert(tileRows);
	if (tErr) {
		await sb.from('vs_personal_boards').delete().eq('id', board.id);
		return { ok: false, reason: 'clog_unavailable' };
	}

	return {
		ok: true,
		board: {
			id: board.id,
			size: board.size,
			difficulty: board.difficulty,
			rsn: board.rsn,
			created_at: board.created_at,
			locked_at: board.locked_at,
			tiles: chosen.map((c, idx) => ({
				idx,
				item_id: c.item_id,
				item_name: c.item_name,
				ehb: c.ehb,
				source: c.source,
				obtained: false,
				obtained_at: null
			}))
		}
	};
}

// Load the user's current board (null if none).
export async function loadPersonalBoard(userId: string): Promise<PersonalBoard | null> {
	const sb = db();
	const { data: boardRow } = await sb
		.from('vs_personal_boards')
		.select('id, size, difficulty, rsn, created_at, locked_at')
		.eq('user_id', userId)
		.maybeSingle();
	if (!boardRow) return null;
	const board = boardRow as { id: string; size: number; difficulty: number; rsn: string; created_at: string; locked_at: string | null };

	const { data: tileRows } = await sb
		.from('vs_personal_board_tiles')
		.select('idx, item_id, item_name, ehb, source, obtained, obtained_at')
		.eq('board_id', board.id)
		.order('idx', { ascending: true });

	return {
		id: board.id,
		size: board.size,
		difficulty: board.difficulty,
		rsn: board.rsn,
		created_at: board.created_at,
		locked_at: board.locked_at,
		tiles: (tileRows ?? []) as PersonalBoardTile[]
	};
}

// Lock a draft board in: starts progress tracking and the LOCK_DAYS commitment. Idempotent
// (already-locked returns the board unchanged). Only after the window can it be reset.
export type LockResult = { ok: true; board: PersonalBoard } | { ok: false; reason: 'no_board' };

export async function lockPersonalBoard(userId: string): Promise<LockResult> {
	const board = await loadPersonalBoard(userId);
	if (!board) return { ok: false, reason: 'no_board' };
	if (board.locked_at) return { ok: true, board }; // already locked

	const lockedAt = new Date().toISOString();
	await db()
		.from('vs_personal_boards')
		.update({ locked_at: lockedAt })
		.eq('id', board.id)
		.is('locked_at', null);
	return { ok: true, board: { ...board, locked_at: lockedAt } };
}

// Flip a single personal-board tile to obtained (false→true). Used by the Dink
// auto-tracker when a COLLECTION unlock matches a board tile. The `obtained=false`
// guard makes it idempotent: 'credited' if this call flipped it, 'noop' if it was
// already obtained (or the index is gone), 'error' on a transient DB failure. The
// activation rule (drop received_at >= board.locked_at) is enforced by the caller, and
// the active-tiles view only surfaces LOCKED boards, so drafts are never credited.
export async function creditPersonalTile(
	boardId: string,
	idx: number
): Promise<'credited' | 'noop' | 'error'> {
	const { data, error } = await db()
		.from('vs_personal_board_tiles')
		.update({ obtained: true, obtained_at: new Date().toISOString() })
		.eq('board_id', boardId)
		.eq('idx', idx)
		.eq('obtained', false)
		.select('idx');
	if (error) {
		console.error('[personalBoard] creditPersonalTile failed', boardId, idx, error.message);
		return 'error';
	}
	return data && data.length > 0 ? 'credited' : 'noop';
}

export type RefreshResult =
	| { ok: true; newlyObtained: string[]; totalObtained: number }
	| { ok: false; reason: 'no_board' | 'clog_unavailable' | 'not_locked' };

// Re-poll the player's collection log and mark any now-owned tiles obtained. This is
// the live auto-tracker: a tile flips to done the next time the player's clog shows
// the item. Only flips false→true (never un-obtains). Only runs on a LOCKED board —
// a draft isn't tracked until it's locked in.
export async function refreshPersonalBoard(userId: string): Promise<RefreshResult> {
	const board = await loadPersonalBoard(userId);
	if (!board) return { ok: false, reason: 'no_board' };
	if (!board.locked_at) return { ok: false, reason: 'not_locked' };

	const owned = await getOwnedClogNames(userId, board.rsn, true); // force a fresh Temple read
	if (owned == null) return { ok: false, reason: 'clog_unavailable' };

	const sb = db();
	const now = new Date().toISOString();
	const newlyObtained: string[] = [];
	for (const tile of board.tiles) {
		if (tile.obtained) continue;
		if (owned.has(tile.item_name.toLowerCase())) {
			newlyObtained.push(tile.item_name);
			await sb
				.from('vs_personal_board_tiles')
				.update({ obtained: true, obtained_at: now })
				.eq('board_id', board.id)
				.eq('idx', tile.idx);
		}
	}
	const totalObtained = board.tiles.filter((t) => t.obtained).length + newlyObtained.length;
	return { ok: true, newlyObtained, totalObtained };
}
