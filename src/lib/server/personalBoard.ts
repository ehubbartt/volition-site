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
import { fetchTempleCollectionLog, fetchPlayerSkillXp, updateWomPlayer, fetchWikiSyncCA } from './rankData';
import { bestEhbSource, type ItemEhb, type EhbOverrides } from '$lib/ehb';
import { getEhbOverrides } from './ehbOverrides';
import { SKILLS, SKILL_EHP_RATES, roundXp, skillTileHours, type Skill } from '$lib/ehp';
import { CA_TIERS, caTierForDifficulty } from '$lib/ca';
import { getCATasks, type CaTask } from './caNames';
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
	kind: 'item' | 'skill' | 'ca';
	item_id: number | null; // item tiles
	item_name: string | null; // item tiles (also reused as the CA display name on ca tiles)
	ehb: number; // cost in efficient hours (EHB for items, EHP for skills, nominal per-tier for CAs) — drives the gradient
	source: string | null; // boss/raid the EHB is costed from (item tiles)
	skill: string | null; // skill tiles
	target_xp: number | null; // skill tiles: XP goal
	baseline_xp: number | null; // skill tiles: XP at lock
	progress_xp: number | null; // skill tiles: last gained-since-lock (display)
	ca_id: number | null; // ca tiles: WikiSync CA task id
	ca_tier: string | null; // ca tiles: 'easy'..'grandmaster'
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

// Short-lived per-user cache of the player's COMPLETED combat-achievement id set (WikiSync), so
// rerolling a draft doesn't re-hit WikiSync each time — same role as ownedCache for clog items.
// `force` (the explicit refresh) bypasses + refreshes it. Returns null if WikiSync is unreadable.
const caDoneCache = new Map<string, { at: number; done: Set<number> }>();
const CA_TTL_MS = 5 * 60 * 1000;

async function getCompletedCAs(userId: string, rsn: string, force = false): Promise<Set<number> | null> {
	if (!force) {
		const hit = caDoneCache.get(userId);
		if (hit && Date.now() - hit.at < CA_TTL_MS) return hit.done;
	}
	const ids = await fetchWikiSyncCA(rsn);
	if (ids == null) return null;
	const done = new Set(ids);
	caDoneCache.set(userId, { at: Date.now(), done });
	return done;
}

interface Candidate {
	item_id: number;
	item_name: string;
	ehb: number;
	source: string;
}

// All PVM clog items the player is MISSING, each costed at its cheapest EHB source
// (with admin overrides applied), sorted easy→hard.
function missingCandidates(owned: Set<string>, overrides?: EhbOverrides): Candidate[] {
	const out: Candidate[] = [];
	for (const item of ITEM_EHB) {
		if (owned.has(item.name.toLowerCase())) continue; // already have it
		const best = bestEhbSource(item, undefined, overrides);
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

interface SkillPick {
	skill: Skill;
	target_xp: number;
	ehb: number; // EHP-hours cost (for the difficulty gradient)
}

// Pick `count` skilling tiles (distinct skills) as an easy→hard band by difficulty: each
// tile's EHP-hours → a clean rounded XP goal for a random skill via its EHP rate.
function selectSkillTiles(count: number, difficulty: number): SkillPick[] {
	if (count <= 0) return [];
	const pool = [...SKILLS];
	shuffle(pool);
	const picks: SkillPick[] = [];
	for (let i = 0; i < count; i++) {
		const skill = pool[i % pool.length];
		const hours = skillTileHours(difficulty, i, count);
		picks.push({ skill, target_xp: roundXp(hours * SKILL_EHP_RATES[skill]), ehb: hours });
	}
	return picks;
}

interface CaPick {
	ca_id: number;
	name: string;
	tier: string;
	ehb: number; // nominal per-tier cost, only to slot the tile into the easy→hard gradient
}

// Nominal "efficient hours" per CA tier (index into CA_TIERS) — used solely so CA tiles sort
// into the board's easy→hard gradient alongside item/skill tiles. CA tiles display the tier,
// not hours.
const CA_TIER_HOURS = [0.5, 1.5, 4, 10, 25, 60];

// Pick `count` CA tiles for UNCOMPLETED achievements, banded easy→hard by difficulty. Each band
// targets a tier via caTierForDifficulty, then draws a random uncompleted CA of that tier,
// falling back OUTWARD to the nearest tier that still has one available (so an empty target tier
// never wastes a tile). Returns fewer than `count` only if the player has too few CAs left.
function selectCATiles(count: number, difficulty: number, completed: Set<number>, catalogue: CaTask[]): CaPick[] {
	if (count <= 0) return [];
	const byId = new Map<number, CaTask>(catalogue.map((t) => [t.id, t]));
	const byTier: number[][] = CA_TIERS.map(() => []); // uncompleted CA ids per tier index
	for (const t of catalogue) {
		if (completed.has(t.id)) continue;
		const ti = CA_TIERS.indexOf(t.tier as (typeof CA_TIERS)[number]);
		if (ti >= 0) byTier[ti].push(t.id);
	}
	for (const arr of byTier) shuffle(arr);

	const picks: CaPick[] = [];
	for (let i = 0; i < count; i++) {
		const target = caTierForDifficulty(difficulty, i, count);
		let chosen: number | null = null;
		for (let radius = 0; radius < CA_TIERS.length && chosen == null; radius++) {
			const tiers = radius === 0 ? [target] : [target - radius, target + radius];
			for (const ti of tiers) {
				if (ti < 0 || ti >= CA_TIERS.length) continue;
				if (byTier[ti].length) {
					chosen = byTier[ti].pop() as number; // consume so it can't be picked twice
					break;
				}
			}
		}
		if (chosen == null) break; // no uncompleted CAs left anywhere
		const task = byId.get(chosen) as CaTask;
		const ti = Math.max(0, CA_TIERS.indexOf(task.tier as (typeof CA_TIERS)[number]));
		picks.push({ ca_id: chosen, name: task.name, tier: task.tier, ehb: CA_TIER_HOURS[ti] ?? 1 });
	}
	return picks;
}

export type GenerateResult =
	| { ok: true; board: PersonalBoard }
	| {
			ok: false;
			reason: 'no_rsn' | 'clog_unavailable' | 'ca_unavailable' | 'too_few' | 'locked';
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
	difficulty: number,
	includeSkilling = false,
	includeCA = false
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
	// ~1/4 of the board is skilling and ~1/4 is combat achievements when those are enabled; the
	// remainder are clog item tiles. Skills always fill their quota; CA tiles may underfill if
	// the player has few uncompleted achievements left, so the item count is settled afterwards.
	const skillCount = includeSkilling ? Math.round(tileCount / 4) : 0;
	const caTarget = includeCA ? Math.round(tileCount / 4) : 0;

	// CA tiles: needs the player's completed-CA set (WikiSync) + the id→name→tier catalogue.
	let caPicks: CaPick[] = [];
	if (caTarget > 0) {
		const completed = await getCompletedCAs(userId, rsn);
		if (completed == null) return { ok: false, reason: 'ca_unavailable' };
		const catalogue = await getCATasks();
		caPicks = selectCATiles(caTarget, diff, completed, catalogue);
	}

	const skills = selectSkillTiles(skillCount, diff);
	const itemCount = tileCount - skills.length - caPicks.length;

	// Cached owned set: rerolling a draft reshuffles without re-hitting Temple each time.
	const owned = await getOwnedClogNames(userId, rsn);
	if (owned == null) return { ok: false, reason: 'clog_unavailable' };

	const overrides = await getEhbOverrides();
	const pool = missingCandidates(owned, overrides);
	if (pool.length < itemCount) {
		return { ok: false, reason: 'too_few', missing: pool.length, need: itemCount };
	}

	const items = selectGradient(pool, itemCount, diff);

	// Unified placed-tile shape (item / skill / ca), scattered across the grid so it isn't
	// sorted by cost.
	type Placed = {
		kind: 'item' | 'skill' | 'ca';
		item_id: number | null;
		item_name: string | null;
		ehb: number;
		source: string | null;
		skill: string | null;
		target_xp: number | null;
		ca_id: number | null;
		ca_tier: string | null;
	};
	const placed: Placed[] = [
		...items.map((c) => ({ kind: 'item' as const, item_id: c.item_id, item_name: c.item_name, ehb: c.ehb, source: c.source, skill: null, target_xp: null, ca_id: null, ca_tier: null })),
		...skills.map((s) => ({ kind: 'skill' as const, item_id: null, item_name: null, ehb: s.ehb, source: null, skill: s.skill, target_xp: s.target_xp, ca_id: null, ca_tier: null })),
		...caPicks.map((c) => ({ kind: 'ca' as const, item_id: null, item_name: c.name, ehb: c.ehb, source: null, skill: null, target_xp: null, ca_id: c.ca_id, ca_tier: c.tier }))
	];
	shuffle(placed);
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
	const tileRows = placed.map((p, idx) => ({
		board_id: board.id,
		idx,
		kind: p.kind,
		item_id: p.item_id,
		item_name: p.item_name,
		ehb: p.ehb,
		source: p.source,
		skill: p.skill,
		target_xp: p.target_xp,
		ca_id: p.ca_id,
		ca_tier: p.ca_tier,
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
			tiles: placed.map((p, idx) => ({
				idx,
				kind: p.kind,
				item_id: p.item_id,
				item_name: p.item_name,
				ehb: p.ehb,
				source: p.source,
				skill: p.skill,
				target_xp: p.target_xp,
				baseline_xp: null,
				progress_xp: null,
				ca_id: p.ca_id,
				ca_tier: p.ca_tier,
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
		.select('idx, kind, item_id, item_name, ehb, source, skill, target_xp, baseline_xp, progress_xp, ca_id, ca_tier, obtained, obtained_at')
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
	const sb = db();
	await sb.from('vs_personal_boards').update({ locked_at: lockedAt }).eq('id', board.id).is('locked_at', null);

	// Snapshot per-skill XP as the baseline for skilling tiles ("gained since lock"). Best-
	// effort: if WoM is unavailable, baselines stay null and are captured lazily on the first
	// refresh.
	const skillTiles = board.tiles.filter((t) => t.kind === 'skill' && t.skill);
	if (skillTiles.length) {
		await updateWomPlayer(board.rsn);
		const xp = await fetchPlayerSkillXp(board.rsn);
		if (xp) {
			for (const t of skillTiles) {
				const base = xp[t.skill as Skill];
				if (base != null) {
					await sb.from('vs_personal_board_tiles').update({ baseline_xp: base }).eq('board_id', board.id).eq('idx', t.idx);
				}
			}
		}
	}
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

	const sb = db();
	const now = new Date().toISOString();
	const newlyObtained: string[] = [];

	// Item tiles: re-poll the collection log.
	const itemTiles = board.tiles.filter((t) => !t.obtained && t.kind === 'item' && t.item_name);
	if (itemTiles.length) {
		const owned = await getOwnedClogNames(userId, board.rsn, true); // force a fresh Temple read
		if (owned == null) return { ok: false, reason: 'clog_unavailable' };
		for (const tile of itemTiles) {
			if (owned.has((tile.item_name as string).toLowerCase())) {
				newlyObtained.push(tile.item_name as string);
				await sb.from('vs_personal_board_tiles').update({ obtained: true, obtained_at: now }).eq('board_id', board.id).eq('idx', tile.idx);
			}
		}
	}

	// Skill tiles: XP gained since lock (WoM). Best-effort — a WoM outage just leaves progress
	// unchanged this round (not an error). Captures a missing baseline lazily.
	const skillTiles = board.tiles.filter((t) => !t.obtained && t.kind === 'skill' && t.skill);
	if (skillTiles.length) {
		await updateWomPlayer(board.rsn);
		const xp = await fetchPlayerSkillXp(board.rsn);
		if (xp) {
			for (const t of skillTiles) {
				const current = xp[t.skill as Skill];
				if (current == null) continue;
				if (t.baseline_xp == null) {
					// Lock-time snapshot failed; set the baseline now and credit from here on.
					await sb.from('vs_personal_board_tiles').update({ baseline_xp: current, progress_xp: 0 }).eq('board_id', board.id).eq('idx', t.idx);
					continue;
				}
				const gained = Math.max(0, current - t.baseline_xp);
				const done = t.target_xp != null && gained >= t.target_xp;
				await sb
					.from('vs_personal_board_tiles')
					.update({ progress_xp: gained, ...(done ? { obtained: true, obtained_at: now } : {}) })
					.eq('board_id', board.id)
					.eq('idx', t.idx);
				if (done) newlyObtained.push(t.skill as string);
			}
		}
	}

	// CA tiles: re-poll WikiSync's completed-CA set and flip any now-completed tile. Best-effort —
	// a WikiSync outage just leaves them unchanged this round (not an error), like the WoM path.
	const caTiles = board.tiles.filter((t) => !t.obtained && t.kind === 'ca' && t.ca_id != null);
	if (caTiles.length) {
		const done = await getCompletedCAs(userId, board.rsn, true); // force a fresh WikiSync read
		if (done) {
			for (const t of caTiles) {
				if (done.has(t.ca_id as number)) {
					const label = t.item_name ?? `Combat achievement #${t.ca_id}`;
					newlyObtained.push(label);
					await sb.from('vs_personal_board_tiles').update({ obtained: true, obtained_at: now }).eq('board_id', board.id).eq('idx', t.idx);
				}
			}
		}
	}

	const totalObtained = board.tiles.filter((t) => t.obtained).length + newlyObtained.length;
	return { ok: true, newlyObtained, totalObtained };
}
