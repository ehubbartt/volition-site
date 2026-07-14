// SERVER-ONLY: personal PVM collection-log bingo boards.
//
// A user generates a private N×N grid (N = 3..5) of collection-log items they do NOT
// already own, drawn from the PVM boss/raid clog universe (itemEhb.json) and balanced
// by EHB-to-obtain into an easy→hard gradient scaled by a difficulty dial. Tiles are
// auto-marked "obtained" by re-polling the player's collection log (Temple), WiseOldMan
// (skill XP), WikiSync (combat achievements) and the Dink auto-tracker. One board per user.
//
// STORAGE (events-v2 spine, see docs/EVENTS.md): a board is a `vs_events` row (kind='personal',
// owner_user_id set) whose tiles are `vs_tiles` rows; every completion — auto or manual — is an
// approved `vs_submissions` ledger row (source='dink'|'clog'|'wom'|'wikisync'|'manual'). A tile's
// `obtained` is DERIVED from the ledger (no boolean column). Display/config extras live in
// `vs_tiles.meta`; auto-track rules live in `vs_tiles.triggers`.
//
// LIFECYCLE: a board starts as a DRAFT (locked_at = null) — the owner can reroll it freely and it
// is NOT tracked. LOCKING it (sets vs_events.locked_at) starts tracking and commits it for
// LOCK_DAYS; only after that window can it be reset and regenerated.

import { db } from './db';
import { fetchTempleCollectionLog, fetchPlayerSkillXp, updateWomPlayer, fetchWikiSyncCA } from './rankData';
import { bestEhbSource, isPetItem, type ItemEhb, type EhbOverrides } from '$lib/ehb';
import { getEhbOverrides, getExcludedItemIds } from './ehbOverrides';
import { uploadProof } from './submissions';
import { grantPlayerVp } from './playerStats';
import { MAX_IMAGES_PER_SUBMISSION, BINGO_BUCKET } from '$lib/bingo/config';
import { TILE_SKILLS, SKILL_EHP_RATES, MAX_SKILL_XP, roundXp, skillTileHours, type Skill } from '$lib/ehp';
import { CA_TIERS, caTierForDifficulty } from '$lib/ca';
import { getCATasks, type CaTask } from './caNames';
import itemEhbData from './data/itemEhb.json';

const ITEM_EHB = itemEhbData as ItemEhb[];

export const MIN_SIZE = 3;
export const MAX_SIZE = 5;
export const MIN_DIFFICULTY = 1;
export const MAX_DIFFICULTY = 10;

// Personal boards are vs_events rows with this kind + a per-user slug.
const PERSONAL_KIND = 'personal';
const personalSlug = (userId: string) => `personal-${userId}`;

// ── VP rewards ────────────────────────────────────────────────────────────────
// Completing a full row/column/diagonal pays LINE VP; completing every tile pays the
// BLACKOUT bonus on top. Both scale with the board's difficulty (1-10) — with a
// quadratic term so the hard end pays disproportionately more — and with size (a 7×7
// line is longer and a 7×7 blackout far bigger than a 3×3). Tune the formulas here.
//   line(size, diff)     = (4 + 1.5·diff + 0.15·diff²) × size/5   → 5×5: 6 @d1, 15 @d5, 34 @d10
//   blackout(size, diff) = (20 + 7·diff + diff²)       × size/5   → 5×5: 28 @d1, 80 @d5, 190 @d10
export function personalVpAmounts(size: number, difficulty: number): { line: number; blackout: number } {
	const s = Math.max(1, size) / 5;
	const d = Math.min(MAX_DIFFICULTY, Math.max(MIN_DIFFICULTY, difficulty));
	return {
		line: Math.max(1, Math.round((4 + 1.5 * d + 0.15 * d * d) * s)),
		blackout: Math.max(1, Math.round((20 + 7 * d + d * d) * s))
	};
}

// Keys of every fully-completed line: rows r0..r{n-1}, columns c0..c{n-1}, diagonals d0/d1.
function completedLineKeys(size: number, obtained: Set<number>): string[] {
	const out: string[] = [];
	for (let r = 0; r < size; r++) {
		let full = true;
		for (let c = 0; c < size; c++) if (!obtained.has(r * size + c)) { full = false; break; }
		if (full) out.push(`r${r}`);
	}
	for (let c = 0; c < size; c++) {
		let full = true;
		for (let r = 0; r < size; r++) if (!obtained.has(r * size + c)) { full = false; break; }
		if (full) out.push(`c${c}`);
	}
	let d0 = true, d1 = true;
	for (let i = 0; i < size; i++) {
		if (!obtained.has(i * size + i)) d0 = false;
		if (!obtained.has(i * size + (size - 1 - i))) d1 = false;
	}
	if (d0) out.push('d0');
	if (d1) out.push('d1');
	return out;
}

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
	source: string | null; // boss/raid the EHB is costed from (item tiles) / boss for CA image
	skill: string | null; // skill tiles
	target_xp: number | null; // skill tiles: XP goal
	baseline_xp: number | null; // skill tiles: XP at lock
	progress_xp: number | null; // skill tiles: last gained-since-lock (display)
	ca_id: number | null; // ca tiles: WikiSync CA task id
	ca_tier: string | null; // ca tiles: 'easy'..'grandmaster'
	// Item tiles: how they auto-complete. 'collection' (default) = clog unlock;
	// 'loot' = the drop must land while locked (already-owned items, test boards).
	match_type: 'loot' | 'collection';
	manual: boolean; // owner-attested via a manual submission (vs auto-tracked)
	proof_urls: string[] | null; // manual-submission proof screenshots
	obtained: boolean;
	obtained_at: string | null;
	pending: boolean; // a manual submission is awaiting admin review (not yet credited)
	rejected: boolean; // the latest manual submission was rejected (resubmission allowed)
	rejection_note: string | null; // reviewer's reason, shown to the player
}

export interface PersonalBoard {
	id: string; // the vs_events row id
	size: number;
	difficulty: number;
	rsn: string;
	created_at: string;
	locked_at: string | null; // null = draft (reroll freely, not tracked)
	tiles: PersonalBoardTile[];
}

// ── Ledger-backed storage helpers ─────────────────────────────────────────────

interface EventRow {
	id: string;
	structure: { size?: number; difficulty?: number; rsn?: string } | null;
	created_at: string;
	locked_at: string | null;
}

// The user's personal-board event row (null if none).
async function loadPersonalEvent(userId: string): Promise<EventRow | null> {
	const { data } = await db()
		.from('vs_events')
		.select('id, structure, created_at, locked_at')
		.eq('owner_user_id', userId)
		.eq('kind', PERSONAL_KIND)
		.maybeSingle();
	return (data as EventRow) ?? null;
}

interface Completion {
	source: string | null;
	proof_urls: string[] | null;
	at: string;
}

// Approved ledger credits for this board, keyed by tile_key → how it was completed.
async function getCompletions(eventId: string, userId: string): Promise<Map<string, Completion>> {
	const { data } = await db()
		.from('vs_submissions')
		.select('target_id, source, proof_urls, submitted_at')
		.eq('event_id', eventId)
		.eq('user_id', userId)
		.eq('status', 'approved');
	const out = new Map<string, Completion>();
	for (const r of (data ?? []) as { target_id: string; source: string | null; proof_urls: string[] | null; submitted_at: string }[]) {
		if (!out.has(r.target_id)) out.set(r.target_id, { source: r.source ?? null, proof_urls: r.proof_urls ?? null, at: r.submitted_at });
	}
	return out;
}

// Tile keys with a manual submission awaiting admin review (drives the tile's
// "pending" state and blocks duplicate submissions).
async function getPendingTileKeys(eventId: string, userId: string): Promise<Set<string>> {
	const { data } = await db()
		.from('vs_submissions')
		.select('target_id')
		.eq('event_id', eventId)
		.eq('user_id', userId)
		.eq('status', 'pending');
	return new Set(((data ?? []) as { target_id: string }[]).map((r) => r.target_id));
}

// Latest rejected manual submission per tile (target_id → reviewer note), so the board
// can tell the player their claim was turned down instead of silently reopening the tile.
// Superseded by any approved credit or newer pending claim at render time.
async function getRejections(eventId: string, userId: string): Promise<Map<string, string | null>> {
	const { data } = await db()
		.from('vs_submissions')
		.select('target_id, review_note, submitted_at')
		.eq('event_id', eventId)
		.eq('user_id', userId)
		.eq('status', 'rejected')
		.order('submitted_at', { ascending: false });
	const out = new Map<string, string | null>();
	for (const r of (data ?? []) as { target_id: string; review_note: string | null }[]) {
		if (!out.has(r.target_id)) out.set(r.target_id, r.review_note ?? null);
	}
	return out;
}

// A generated/placed tile (kind + all kind-specific fields), before it's a DB row.
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
	// Item tiles only: how Dink drops match this tile. Omitted = 'collection' (clog
	// unlock). The admin test board sets 'loot' so plain ground drops (bones) credit it.
	match_type?: 'loot' | 'collection';
};

// Placed tile → vs_tiles insert row. Display/config extras go in `meta`; auto-track rules in
// `triggers` (item = Dink id + Temple clog name; skill = WoM XP; ca = WikiSync id; empty = manual).
function tileToRow(eventId: string, p: Placed, idx: number) {
	const meta: Record<string, unknown> = { ehb: p.ehb };
	const triggers: Record<string, unknown>[] = [];
	if (p.kind === 'item') {
		meta.item_id = p.item_id;
		meta.item_name = p.item_name;
		meta.source = p.source;
		// The active-tiles view reads meta.match_type (default 'collection') to decide
		// which Dink notification kind credits this tile.
		if (p.match_type) meta.match_type = p.match_type;
		triggers.push({ type: 'dink_item', match_key: String(p.item_id), required_qty: 1 });
		triggers.push({ type: 'clog', match_key: p.item_name, required_qty: 1 });
	} else if (p.kind === 'skill') {
		meta.skill = p.skill;
		meta.target_xp = p.target_xp;
		triggers.push({ type: 'skill_xp', match_key: p.skill, required_qty: p.target_xp });
	} else {
		meta.ca_id = p.ca_id;
		meta.ca_tier = p.ca_tier;
		meta.source = p.source; // boss/NPC for the CA image
		triggers.push({ type: 'combat_achievement', match_key: String(p.ca_id), required_qty: 1 });
	}
	return {
		event_id: eventId,
		tile_key: String(idx),
		kind: p.kind,
		name: p.kind === 'skill' ? p.skill : p.item_name,
		position: idx,
		points: 0,
		meta,
		triggers
	};
}

interface TileRow {
	tile_key: string;
	kind: string;
	name: string | null;
	position: number | null;
	meta: Record<string, unknown> | null;
}

// vs_tiles row (+ its ledger completion, if any) → the PersonalBoardTile the page renders.
// `rejection` = the latest rejected claim's reviewer note (undefined if never rejected);
// it only surfaces while the tile is neither completed nor pending again.
function rowToTile(
	r: TileRow,
	comp?: Completion,
	pending = false,
	rejection?: string | null
): PersonalBoardTile {
	const meta = (r.meta ?? {}) as Record<string, unknown>;
	const kind = (r.kind as 'item' | 'skill' | 'ca') ?? 'item';
	const num = (v: unknown): number | null => (v == null ? null : Number(v));
	return {
		idx: r.position ?? Number(r.tile_key),
		kind,
		item_id: num(meta.item_id),
		item_name: kind === 'skill' ? null : (r.name ?? (meta.item_name as string) ?? null),
		ehb: Number(meta.ehb ?? 0),
		source: (meta.source as string) ?? null,
		skill: (meta.skill as string) ?? null,
		target_xp: num(meta.target_xp),
		baseline_xp: num(meta.baseline_xp),
		progress_xp: num(meta.progress),
		ca_id: num(meta.ca_id),
		ca_tier: (meta.ca_tier as string) ?? null,
		match_type: meta.match_type === 'loot' ? 'loot' : 'collection',
		manual: comp?.source === 'manual',
		proof_urls: comp?.proof_urls ?? null,
		obtained: !!comp,
		obtained_at: comp?.at ?? null,
		pending: !comp && pending,
		rejected: !comp && !pending && rejection !== undefined,
		rejection_note: !comp && !pending && rejection !== undefined ? rejection : null
	};
}

// Merge a patch into a tile's `meta` jsonb (read-modify-write; personal boards are tiny).
async function updateTileMeta(eventId: string, tileKey: string, patch: Record<string, unknown>): Promise<void> {
	const sb = db();
	const { data } = await sb.from('vs_tiles').select('meta').eq('event_id', eventId).eq('tile_key', tileKey).maybeSingle();
	const meta = { ...(((data?.meta as Record<string, unknown>) ?? {})), ...patch };
	await sb.from('vs_tiles').update({ meta }).eq('event_id', eventId).eq('tile_key', tileKey);
}

// Credit a tile by appending an APPROVED submission to the ledger. Idempotent: a tile that already
// has an approved credit is a no-op (personal tiles complete once). Returns what happened.
async function creditTile(
	eventId: string,
	userId: string,
	tileKey: string,
	source: string,
	opts?: { proofUrls?: string[]; targetLabel?: string }
): Promise<'credited' | 'noop' | 'error'> {
	const sb = db();
	const { data: existing } = await sb
		.from('vs_submissions')
		.select('id')
		.eq('event_id', eventId)
		.eq('user_id', userId)
		.eq('target_id', tileKey)
		.eq('status', 'approved')
		.limit(1);
	if (existing && existing.length) return 'noop';
	const now = new Date().toISOString();
	const { error } = await sb.from('vs_submissions').insert({
		event_id: eventId,
		user_id: userId,
		target_id: tileKey,
		target_label: opts?.targetLabel ?? null,
		quantity: 1,
		status: 'approved',
		source,
		test: false, // vs_submissions.test is set on every createSubmission insert (may be NOT NULL)
		proof_urls: opts?.proofUrls ?? [], // NOT NULL column — a dink/clog credit has no proofs

		submitted_at: now,
		reviewed_at: now
	});
	if (error) {
		console.error('[personalBoard] creditTile failed', eventId, tileKey, source, error.message);
		return 'error';
	}
	return 'credited';
}

// ── Collection-log / WoM / WikiSync polling caches ────────────────────────────

// Flatten the Temple collection-log response into a lowercased set of OWNED item names.
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

const skillXpCache = new Map<string, { at: number; xp: Record<Skill, number> | null }>();
const SKILL_XP_TTL_MS = 5 * 60 * 1000;

async function getPlayerSkillXpCached(userId: string, rsn: string): Promise<Record<Skill, number> | null> {
	const hit = skillXpCache.get(userId);
	if (hit && Date.now() - hit.at < SKILL_XP_TTL_MS) return hit.xp;
	const xp = await fetchPlayerSkillXp(rsn);
	skillXpCache.set(userId, { at: Date.now(), xp });
	return xp;
}

// ── Board generation (selection logic — unchanged by the storage migration) ────

interface Candidate {
	item_id: number;
	item_name: string;
	ehb: number;
	source: string;
	// Already in the player's collection log. Owned picks become LOOT-matched tiles
	// (the drop must land again while the board is locked) — a new clog unlock can
	// never fire for something you already have.
	owned?: boolean;
}

// Board-eligible PVM clog items, each costed at its cheapest EHB source (with admin
// overrides applied), sorted easy→hard. Items the player already OWNS are skipped
// unless includeOwned — then they stay in the pool, flagged. Pet drops excluded
// unless includePets.
function missingCandidates(
	owned: Set<string>,
	overrides?: EhbOverrides,
	includePets = true,
	excludedIds?: Set<number>,
	includeOwned = false
): Candidate[] {
	const out: Candidate[] = [];
	for (const item of ITEM_EHB) {
		const has = owned.has(item.name.toLowerCase());
		if (has && !includeOwned) continue; // already have it
		if (!includePets && isPetItem(item.name)) continue; // pets filtered out
		if (excludedIds?.has(item.id)) continue; // admin-excluded from the pool
		const best = bestEhbSource(item, undefined, overrides);
		if (!best) continue; // no computable EHB source
		out.push({ item_id: item.id, item_name: item.name, ehb: best.ehb, source: best.src.s, owned: has });
	}
	out.sort((a, b) => a.ehb - b.ehb);
	return out;
}

// Minimum EHB per item tile by difficulty — the gradient used to start at the very
// cheapest items in the pool, so even Insane boards carried two-minute tiles.
// Quadratic ramp: 0 @d1-2, ~0.4h @d3, ~1.6h @d5, ~3.6h @d7, ~8.1h @d10.
function minTileEhb(difficulty: number): number {
	const d = Math.min(MAX_DIFFICULTY, Math.max(MIN_DIFFICULTY, difficulty));
	return 0.1 * (d - 1) * (d - 1);
}

// Pick N tiles as an easy→hard GRADIENT scaled by difficulty.
function selectGradient(pool: Candidate[], count: number, difficulty: number): Candidate[] {
	if (pool.length <= count) return pool.slice(); // take everything we have
	const d = Math.min(MAX_DIFFICULTY, Math.max(MIN_DIFFICULTY, difficulty));
	const frac = 0.25 + (0.75 * (d - MIN_DIFFICULTY)) / (MAX_DIFFICULTY - MIN_DIFFICULTY);
	const ceiling = Math.max(count, Math.round(pool.length * frac));
	const window = pool.slice(0, ceiling);
	const picked: Candidate[] = [];
	const used = new Set<number>();
	for (let i = 0; i < count; i++) {
		const lo = Math.floor((i * window.length) / count);
		const hi = Math.max(lo + 1, Math.floor(((i + 1) * window.length) / count));
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
	return picked;
}

// Fisher-Yates in-place shuffle.
function shuffle<T>(arr: T[]): void {
	for (let i = arr.length - 1; i > 0; i--) {
		const j = Math.floor(Math.random() * (i + 1));
		[arr[i], arr[j]] = [arr[j], arr[i]];
	}
}

interface SkillPick {
	skill: Skill;
	target_xp: number;
	ehb: number;
}

// Pick up to `count` DISTINCT skilling tiles as an easy→hard band by difficulty.
function selectSkillTiles(count: number, difficulty: number, allowed: readonly Skill[] = TILE_SKILLS): SkillPick[] {
	if (count <= 0 || allowed.length === 0) return [];
	const pool = [...allowed];
	shuffle(pool);
	const n = Math.min(count, pool.length);
	const picks: SkillPick[] = [];
	for (let i = 0; i < n; i++) {
		const skill = pool[i];
		const hours = skillTileHours(difficulty, i, n);
		picks.push({ skill, target_xp: roundXp(hours * SKILL_EHP_RATES[skill]), ehb: hours });
	}
	return picks;
}

interface CaPick {
	ca_id: number;
	name: string;
	tier: string;
	monster: string | null;
	ehb: number;
}

const CA_TIER_HOURS = [0.5, 1.5, 4, 10, 25, 60];

// Pick `count` CA tiles for UNCOMPLETED achievements, banded easy→hard by difficulty.
function selectCATiles(count: number, difficulty: number, completed: Set<number>, catalogue: CaTask[]): CaPick[] {
	if (count <= 0) return [];
	const byId = new Map<number, CaTask>(catalogue.map((t) => [t.id, t]));
	const byTier: number[][] = CA_TIERS.map(() => []);
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
					chosen = byTier[ti].pop() as number;
					break;
				}
			}
		}
		if (chosen == null) break;
		const task = byId.get(chosen) as CaTask;
		const ti = Math.max(0, CA_TIERS.indexOf(task.tier as (typeof CA_TIERS)[number]));
		picks.push({ ca_id: chosen, name: task.name, tier: task.tier, monster: task.monster ?? null, ehb: CA_TIER_HOURS[ti] ?? 1 });
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

// Generate (and persist, replacing any existing) a DRAFT board for the user. Refuses if the
// current board is LOCKED and still inside its commitment window.
export async function generatePersonalBoard(
	userId: string,
	rsn: string | null,
	size: number,
	difficulty: number,
	includeSkilling = false,
	includeCA = false,
	includePets = true,
	excludeMaxedSkills = false,
	includeOwned = false,
	keepLineKey: string | null = null
): Promise<GenerateResult> {
	if (!rsn) return { ok: false, reason: 'no_rsn' };

	// A locked board can't be rerolled/reset until its commitment window elapses.
	const existing = await loadPersonalEvent(userId);
	if (existing?.locked_at) {
		const reset = boardResettableAt(existing.locked_at);
		if (reset && Date.now() < new Date(reset).getTime()) {
			return { ok: false, reason: 'locked', resettable_at: reset };
		}
	}

	const n = Math.min(MAX_SIZE, Math.max(MIN_SIZE, Math.floor(size)));
	const diff = Math.min(MAX_DIFFICULTY, Math.max(MIN_DIFFICULTY, Math.floor(difficulty)));
	const tileCount = n * n;

	// Keep-line reroll: hold one row ('r2') or column ('c0') of the current DRAFT in
	// place and refill only the other tiles. Silently ignored when it can't apply
	// (no draft, size changed, malformed key) — the reroll then behaves as a full one.
	const kept = new Map<number, Placed>(); // board position → held tile
	const keyMatch = keepLineKey ? /^([rc])([0-9]+)$/.exec(keepLineKey) : null;
	if (keyMatch && existing && !existing.locked_at) {
		const line = Number(keyMatch[2]);
		const current = await loadPersonalBoard(userId);
		if (current && current.size === n && line < n) {
			const idxs =
				keyMatch[1] === 'r'
					? Array.from({ length: n }, (_, c) => line * n + c)
					: Array.from({ length: n }, (_, r) => r * n + line);
			for (const idx of idxs) {
				const t = current.tiles.find((x) => x.idx === idx);
				if (!t) {
					kept.clear();
					break;
				}
				kept.set(idx, {
					kind: t.kind,
					item_id: t.item_id,
					item_name: t.item_name,
					ehb: t.ehb,
					source: t.source,
					skill: t.skill,
					target_xp: t.target_xp,
					ca_id: t.ca_id,
					ca_tier: t.ca_tier,
					...(t.match_type === 'loot' ? { match_type: 'loot' as const } : {})
				});
			}
		}
	}
	const keptTiles = [...kept.values()];
	const keptSkillSet = new Set(keptTiles.filter((p) => p.kind === 'skill').map((p) => p.skill));
	const keptCaIds = keptTiles.filter((p) => p.kind === 'ca').map((p) => p.ca_id as number);
	const keptItemIds = new Set(keptTiles.filter((p) => p.kind === 'item').map((p) => p.item_id));
	const newCount = tileCount - kept.size;

	// Composition targets are for the WHOLE board; held tiles count toward their kind.
	const skillCount = Math.max(
		0,
		Math.min(newCount, (includeSkilling ? Math.round(tileCount / 4) : 0) - keptSkillSet.size)
	);
	const caTarget = Math.max(
		0,
		Math.min(newCount - skillCount, (includeCA ? Math.round(tileCount / 4) : 0) - keptCaIds.length)
	);

	// CA tiles: needs the player's completed-CA set (WikiSync) + the id→name→tier catalogue.
	let caPicks: CaPick[] = [];
	if (caTarget > 0) {
		const completed = await getCompletedCAs(userId, rsn);
		if (completed == null) return { ok: false, reason: 'ca_unavailable' };
		const catalogue = await getCATasks();
		// Held CA tiles count as "completed" here so the refill can't duplicate them.
		caPicks = selectCATiles(caTarget, diff, new Set([...completed, ...keptCaIds]), catalogue);
	}

	// Optionally drop skills the player has already 99'd (best-effort).
	let allowedSkills = TILE_SKILLS;
	if (skillCount > 0 && excludeMaxedSkills) {
		const xp = await getPlayerSkillXpCached(userId, rsn);
		if (xp) allowedSkills = TILE_SKILLS.filter((s) => (xp[s] ?? 0) < MAX_SKILL_XP);
	}
	if (keptSkillSet.size) allowedSkills = allowedSkills.filter((s) => !keptSkillSet.has(s));

	const skills = selectSkillTiles(skillCount, diff, allowedSkills);
	const itemCount = newCount - skills.length - caPicks.length;

	const owned = await getOwnedClogNames(userId, rsn);
	if (owned == null) return { ok: false, reason: 'clog_unavailable' };

	const overrides = await getEhbOverrides();
	const excludedIds = await getExcludedItemIds();
	const pool = missingCandidates(owned, overrides, includePets, excludedIds, includeOwned).filter(
		(c) => !keptItemIds.has(c.item_id)
	);
	if (pool.length < itemCount) {
		return { ok: false, reason: 'too_few', missing: pool.length, need: itemCount };
	}

	// Enforce the difficulty's per-item EHB floor (pool is sorted easy→hard). If the
	// player's log can't fill the board above the floor, fall back to their hardest
	// remaining items (2× the need, so the gradient keeps some spread) rather than fail.
	const floor = minTileEhb(diff);
	const floored = pool.filter((c) => c.ehb >= floor);
	const itemsPool =
		floored.length >= itemCount ? floored : pool.slice(-Math.min(pool.length, itemCount * 2));

	const items = selectGradient(itemsPool, itemCount, diff);

	const fresh: Placed[] = [
		// Owned picks are LOOT-matched (drop must land again, credited via Dink);
		// missing picks stay collection-matched (clog unlock).
		...items.map((c) => ({ kind: 'item' as const, item_id: c.item_id, item_name: c.item_name, ehb: c.ehb, source: c.source, skill: null, target_xp: null, ca_id: null, ca_tier: null, ...(c.owned ? { match_type: 'loot' as const } : {}) })),
		...skills.map((s) => ({ kind: 'skill' as const, item_id: null, item_name: null, ehb: s.ehb, source: null, skill: s.skill, target_xp: s.target_xp, ca_id: null, ca_tier: null })),
		...caPicks.map((c) => ({ kind: 'ca' as const, item_id: null, item_name: c.name, ehb: c.ehb, source: c.monster, skill: null, target_xp: null, ca_id: c.ca_id, ca_tier: c.tier }))
	];
	shuffle(fresh);

	// Held tiles stay at their exact positions; fresh picks fill the rest in order.
	let placed: Placed[];
	if (kept.size > 0) {
		placed = [];
		let j = 0;
		for (let idx = 0; idx < tileCount; idx++) placed.push(kept.get(idx) ?? fresh[j++]);
	} else {
		placed = fresh;
	}
	return persistPersonalBoard(existing, userId, rsn, n, diff, placed);
}

// Replace (or create) the user's draft board with the given placed tiles. Shared by the
// normal generator and the admin test-board generator.
async function persistPersonalBoard(
	existing: EventRow | null,
	userId: string,
	rsn: string,
	n: number,
	diff: number,
	placed: Placed[],
	test = false // admin test board: flagged in structure so VP settlement skips it
): Promise<GenerateResult> {
	const sb = db();

	// One board per user: drop the old event (tiles cascade) + its ledger rows before inserting.
	if (existing) {
		await sb.from('vs_submissions').delete().eq('event_id', existing.id);
		await sb.from('vs_events').delete().eq('id', existing.id);
	}

	const { data: evRow, error: eErr } = await sb
		.from('vs_events')
		.insert({
			slug: personalSlug(userId),
			name: 'Personal board',
			kind: PERSONAL_KIND,
			owner_user_id: userId,
			team_size: 1,
			// NOT 'open': personal boards are gated by locked_at, not status, and site lists filter
			// them by kind='personal'. Keeping status out of 'open' also stops the bot's
			// event-announce poller (which reads status='open') from posting them to Discord.
			status: 'draft',
			structure: { size: n, difficulty: diff, rsn, ...(test ? { test: true } : {}) }
		})
		.select('id, structure, created_at, locked_at')
		.single();
	if (eErr || !evRow) return { ok: false, reason: 'clog_unavailable' };
	const ev = evRow as EventRow;

	const { error: tErr } = await sb.from('vs_tiles').insert(placed.map((p, idx) => tileToRow(ev.id, p, idx)));
	if (tErr) {
		await sb.from('vs_events').delete().eq('id', ev.id);
		return { ok: false, reason: 'clog_unavailable' };
	}

	return {
		ok: true,
		board: {
			id: ev.id,
			size: n,
			difficulty: diff,
			rsn,
			created_at: ev.created_at,
			locked_at: ev.locked_at,
			tiles: placed.map((p, idx) => rowToTile(tileToRow(ev.id, p, idx)))
		}
	};
}

// TEMPORARY admin test board: the easiest possible 3x3 for end-to-end tracking checks —
// 3 trivially-farmable LOOT drops (bones/feather/cowhide, matched as plain loot rather
// than clog unlocks — requires the meta->match_type view change in active_tiles.sql),
// 3 skill tiles at 1 XP each (any XP gain after locking completes them), and the 3
// easiest-tier CAs the player hasn't done. Admin-gated on the page action.
const TEST_LOOT_ITEMS: { item_id: number; item_name: string; source: string }[] = [
	{ item_id: 526, item_name: 'Bones', source: 'Chicken' },
	{ item_id: 314, item_name: 'Feather', source: 'Chicken' },
	{ item_id: 1739, item_name: 'Cowhide', source: 'Cow' }
];
export async function generateTestPersonalBoard(
	userId: string,
	rsn: string | null
): Promise<GenerateResult> {
	if (!rsn) return { ok: false, reason: 'no_rsn' };

	// Unlike the normal generator, the LOCK window is NOT enforced: this is an
	// admin-only test tool, and being stuck behind a 30-day commitment on a stale
	// board would defeat its purpose. Regenerating still wipes the old board.
	const existing = await loadPersonalEvent(userId);

	const completed = await getCompletedCAs(userId, rsn);
	if (completed == null) return { ok: false, reason: 'ca_unavailable' };
	const catalogue = await getCATasks();
	const caPool = catalogue
		.filter((t) => !completed.has(t.id))
		.sort(
			(a, b) =>
				CA_TIERS.indexOf(a.tier as (typeof CA_TIERS)[number]) -
				CA_TIERS.indexOf(b.tier as (typeof CA_TIERS)[number])
		);
	const caPicks: CaPick[] = caPool.slice(0, 3).map((task) => {
		const ti = Math.max(0, CA_TIERS.indexOf(task.tier as (typeof CA_TIERS)[number]));
		return {
			ca_id: task.id,
			name: task.name,
			tier: task.tier,
			monster: task.monster ?? null,
			ehb: CA_TIER_HOURS[ti] ?? 1
		};
	});

	const skillsPool = [...TILE_SKILLS];
	shuffle(skillsPool);
	const skills: SkillPick[] = skillsPool
		.slice(0, 3)
		.map((skill) => ({ skill, target_xp: 1, ehb: 0 }));

	// Fixed common drops matched as plain LOOT (not clog unlocks), so killing a
	// chicken/cow ticks them — completable in minutes regardless of the player's log.
	const placed: Placed[] = [
		...TEST_LOOT_ITEMS.map((c) => ({ kind: 'item' as const, item_id: c.item_id, item_name: c.item_name, ehb: 0, source: c.source, skill: null, target_xp: null, ca_id: null, ca_tier: null, match_type: 'loot' as const })),
		...skills.map((s) => ({ kind: 'skill' as const, item_id: null, item_name: null, ehb: s.ehb, source: null, skill: s.skill, target_xp: s.target_xp, ca_id: null, ca_tier: null })),
		...caPicks.map((c) => ({ kind: 'ca' as const, item_id: null, item_name: c.name, ehb: c.ehb, source: c.monster, skill: null, target_xp: null, ca_id: c.ca_id, ca_tier: c.tier }))
	];
	shuffle(placed);
	return persistPersonalBoard(existing, userId, rsn, 3, MIN_DIFFICULTY, placed, true);
}

// Load the user's current board (null if none).
export async function loadPersonalBoard(userId: string): Promise<PersonalBoard | null> {
	const ev = await loadPersonalEvent(userId);
	if (!ev) return null;
	const structure = ev.structure ?? {};
	const { data: tileRows } = await db()
		.from('vs_tiles')
		.select('tile_key, kind, name, position, meta')
		.eq('event_id', ev.id)
		.order('position', { ascending: true });
	const [comp, pendingKeys, rejections] = await Promise.all([
		getCompletions(ev.id, userId),
		getPendingTileKeys(ev.id, userId),
		getRejections(ev.id, userId)
	]);
	return {
		id: ev.id,
		size: Number(structure.size ?? 5),
		difficulty: Number(structure.difficulty ?? 5),
		rsn: String(structure.rsn ?? ''),
		created_at: ev.created_at,
		locked_at: ev.locked_at,
		tiles: ((tileRows ?? []) as TileRow[]).map((r) =>
			rowToTile(
				r,
				comp.get(r.tile_key),
				pendingKeys.has(r.tile_key),
				rejections.has(r.tile_key) ? rejections.get(r.tile_key) : undefined
			)
		)
	};
}

// ── VP settlement ──────────────────────────────────────────────────────────────
// Awarded state IS the ledger: every paid line/blackout is a vs_submissions row with
// target_id 'vp:<lineKey>' (or 'vp:blackout'), source 'vp', and the VP amount granted
// in `quantity` — auditable in the DB, and wiped with the board on a reroll like every
// other board row. Settling compares the CURRENTLY completed lines/blackout against
// those rows and pays only the difference, so it's safe to run on every board view
// (poll-on-read, like the drop consumer). An in-process per-user guard stops two
// concurrent views double-paying (single adapter-node process, owner-only trigger).
// Test boards never pay.

const VP_KEY_PREFIX = 'vp:';
const vpSettleInflight = new Set<string>();

export interface PersonalVpState {
	line: number; // VP per completed row/column/diagonal on this board
	blackout: number; // bonus VP for completing every tile
	earned: number; // VP this board has paid out so far
	test: boolean; // admin test board — rewards disabled
}

export async function settlePersonalVp(
	user: { id: string; discord_id: string | null; rsn: string | null },
	board: PersonalBoard
): Promise<PersonalVpState> {
	const amounts = personalVpAmounts(board.size, board.difficulty);
	const sb = db();

	const [{ data: evRow }, { data: vpRows, error: readErr }] = await Promise.all([
		sb.from('vs_events').select('structure').eq('id', board.id).maybeSingle(),
		sb
			.from('vs_submissions')
			.select('target_id, quantity')
			.eq('event_id', board.id)
			.eq('user_id', user.id)
			.eq('source', 'vp')
			.eq('status', 'approved')
	]);
	const structure = ((evRow as { structure?: Record<string, unknown> } | null)?.structure ?? {}) as Record<string, unknown>;
	const isTest = structure.test === true;
	const paid = (vpRows ?? []) as { target_id: string; quantity: number }[];
	const awarded = new Set(paid.map((r) => r.target_id));
	const earned = paid.reduce((sum, r) => sum + (Number(r.quantity) || 0), 0);
	const base = { line: amounts.line, blackout: amounts.blackout, test: isTest };

	if (readErr) {
		console.error('[personalBoard] vp ledger read failed', board.id, readErr.message);
		return { ...base, earned };
	}
	if (!board.locked_at || isTest) return { ...base, earned };

	const obtained = new Set(board.tiles.filter((t) => t.obtained).map((t) => t.idx));
	const wanted: { key: string; vp: number; label: string }[] = completedLineKeys(board.size, obtained)
		.map((k) => ({ key: VP_KEY_PREFIX + k, vp: amounts.line, label: `Bingo line ${k}` }))
		.filter((w) => !awarded.has(w.key));
	if (obtained.size >= board.size * board.size && !awarded.has(`${VP_KEY_PREFIX}blackout`)) {
		wanted.push({ key: `${VP_KEY_PREFIX}blackout`, vp: amounts.blackout, label: 'Bingo blackout' });
	}
	if (wanted.length === 0) return { ...base, earned };

	// Re-entrancy guard: a second view racing this one reports the pre-settle total and
	// pays nothing; the next view shows the settled number.
	if (vpSettleInflight.has(user.id)) return { ...base, earned };
	vpSettleInflight.add(user.id);
	try {
		const now = new Date().toISOString();
		const { error: insErr } = await sb.from('vs_submissions').insert(
			wanted.map((w) => ({
				event_id: board.id,
				user_id: user.id,
				target_id: w.key,
				target_label: w.label,
				quantity: w.vp,
				status: 'approved',
				source: 'vp',
				test: false,
				proof_urls: [],
				submitted_at: now,
				reviewed_at: now
			}))
		);
		if (insErr) {
			console.error('[personalBoard] vp award insert failed', board.id, insErr.message);
			return { ...base, earned };
		}
		const delta = wanted.reduce((sum, w) => sum + w.vp, 0);
		await grantPlayerVp(user.discord_id, user.rsn, delta);
		return { ...base, earned: earned + delta };
	} finally {
		vpSettleInflight.delete(user.id);
	}
}

// Lock a draft board in: starts tracking + the LOCK_DAYS commitment. Idempotent.
export type LockResult = { ok: true; board: PersonalBoard } | { ok: false; reason: 'no_board' };

export async function lockPersonalBoard(userId: string): Promise<LockResult> {
	const board = await loadPersonalBoard(userId);
	if (!board) return { ok: false, reason: 'no_board' };
	if (board.locked_at) return { ok: true, board }; // already locked

	const lockedAt = new Date().toISOString();
	await db().from('vs_events').update({ locked_at: lockedAt }).eq('id', board.id).is('locked_at', null);

	// Snapshot per-skill XP into each skill tile's meta as the baseline for "gained since lock".
	// Best-effort: if WoM is unavailable, baselines stay null and are captured on the first refresh.
	const skillTiles = board.tiles.filter((t) => t.kind === 'skill' && t.skill);
	if (skillTiles.length) {
		await updateWomPlayer(board.rsn);
		const xp = await fetchPlayerSkillXp(board.rsn);
		if (xp) {
			for (const t of skillTiles) {
				const base = xp[t.skill as Skill];
				if (base != null) await updateTileMeta(board.id, String(t.idx), { baseline_xp: base });
			}
		}
	}
	return { ok: true, board: { ...board, locked_at: lockedAt } };
}

// Credit a personal-board tile from the Dink auto-tracker (COLLECTION unlock match). Idempotent;
// the activation rule (drop.received_at >= locked_at) and locked-only gating are enforced by the
// caller + the active-tiles view. `eventId` is the board's vs_events id, `idx` the tile position.
export async function creditPersonalTile(
	eventId: string,
	idx: number,
	userId: string,
	opts?: { proofUrls?: string[]; targetLabel?: string }
): Promise<'credited' | 'noop' | 'error'> {
	return creditTile(eventId, userId, String(idx), 'dink', opts);
}

export type RefreshResult =
	| { ok: true; newlyObtained: string[]; totalObtained: number }
	| { ok: false; reason: 'no_board' | 'clog_unavailable' | 'not_locked' };

// Re-poll Temple (clog) / WoM (skill XP) / WikiSync (CAs) and append an approved ledger credit for
// any tile now satisfied. Only runs on a LOCKED board. Never un-credits.
export async function refreshPersonalBoard(userId: string): Promise<RefreshResult> {
	const board = await loadPersonalBoard(userId);
	if (!board) return { ok: false, reason: 'no_board' };
	if (!board.locked_at) return { ok: false, reason: 'not_locked' };
	const eventId = board.id;
	const newlyObtained: string[] = [];

	// Item tiles: re-poll the collection log. LOOT-matched tiles (already-owned items,
	// test boards) are skipped — owning the clog slot is exactly what they don't prove;
	// they only complete when the drop lands (Dink) or via manual submission.
	const itemTiles = board.tiles.filter(
		(t) => !t.obtained && t.kind === 'item' && t.item_name && t.match_type !== 'loot'
	);
	if (itemTiles.length) {
		const owned = await getOwnedClogNames(userId, board.rsn, true); // force a fresh Temple read
		if (owned == null) return { ok: false, reason: 'clog_unavailable' };
		for (const t of itemTiles) {
			if (owned.has((t.item_name as string).toLowerCase())) {
				const r = await creditTile(eventId, userId, String(t.idx), 'clog', { targetLabel: t.item_name ?? undefined });
				if (r === 'credited') newlyObtained.push(t.item_name as string);
			}
		}
	}

	// Skill tiles: XP gained since lock (WoM). Best-effort — a WoM outage just leaves progress
	// unchanged this round. Captures a missing baseline lazily.
	const skillTiles = board.tiles.filter((t) => !t.obtained && t.kind === 'skill' && t.skill);
	if (skillTiles.length) {
		await updateWomPlayer(board.rsn);
		const xp = await fetchPlayerSkillXp(board.rsn);
		if (xp) {
			for (const t of skillTiles) {
				const current = xp[t.skill as Skill];
				if (current == null) continue;
				if (t.baseline_xp == null) {
					await updateTileMeta(eventId, String(t.idx), { baseline_xp: current, progress: 0 });
					continue;
				}
				const gained = Math.max(0, current - t.baseline_xp);
				await updateTileMeta(eventId, String(t.idx), { progress: gained });
				if (t.target_xp != null && gained >= t.target_xp) {
					const r = await creditTile(eventId, userId, String(t.idx), 'wom', { targetLabel: t.skill ?? undefined });
					if (r === 'credited') newlyObtained.push(t.skill as string);
				}
			}
		}
	}

	// CA tiles: re-poll WikiSync's completed-CA set. Best-effort.
	const caTiles = board.tiles.filter((t) => !t.obtained && t.kind === 'ca' && t.ca_id != null);
	if (caTiles.length) {
		const done = await getCompletedCAs(userId, board.rsn, true); // force a fresh WikiSync read
		if (done) {
			for (const t of caTiles) {
				if (done.has(t.ca_id as number)) {
					const label = t.item_name ?? `Combat achievement #${t.ca_id}`;
					const r = await creditTile(eventId, userId, String(t.idx), 'wikisync', { targetLabel: label });
					if (r === 'credited') newlyObtained.push(label);
				}
			}
		}
	}

	const totalObtained = board.tiles.filter((t) => t.obtained).length + newlyObtained.length;
	return { ok: true, newlyObtained, totalObtained };
}

export type SubmitTileResult =
	| { ok: true }
	| { ok: false; reason: 'no_board' | 'not_locked' | 'no_tile' | 'already_pending' | 'upload_failed'; error?: string };

// Manual completion claim for a tile (for drops/goals the auto-trackers miss). Uploads any
// proof to the shared bingo bucket, then files a PENDING submission — it surfaces in
// /admin/submissions for approve/reject and only credits the tile once approved. (Dink/clog
// auto-credits skip review; only manual claims are reviewed.) Only on a LOCKED board;
// proof optional; one open claim per tile.
export async function submitPersonalTile(userId: string, idx: number, files: File[]): Promise<SubmitTileResult> {
	const board = await loadPersonalBoard(userId);
	if (!board) return { ok: false, reason: 'no_board' };
	if (!board.locked_at) return { ok: false, reason: 'not_locked' };

	const tile = board.tiles.find((t) => t.idx === idx);
	if (!tile) return { ok: false, reason: 'no_tile' };
	if (tile.obtained) return { ok: true }; // already done
	if (tile.pending) return { ok: false, reason: 'already_pending' };

	const valid = files.filter((f) => f instanceof File && f.size > 0).slice(0, MAX_IMAGES_PER_SUBMISSION);
	const urls: string[] = [];
	const paths: string[] = [];
	const sb = db();
	for (const file of valid) {
		const res = await uploadProof('personal', userId, `${board.id}-${idx}`, file);
		if ('error' in res) {
			if (paths.length) await sb.storage.from(BINGO_BUCKET).remove(paths);
			return { ok: false, reason: 'upload_failed', error: res.error };
		}
		urls.push(res.url);
		paths.push(res.path);
	}

	const { error } = await sb.from('vs_submissions').insert({
		event_id: board.id,
		user_id: userId,
		target_id: String(idx),
		target_label: tile.item_name ?? tile.skill ?? null,
		quantity: 1,
		status: 'pending',
		source: 'manual',
		test: false,
		proof_urls: urls,
		submitted_at: new Date().toISOString()
	});
	if (error) {
		console.error('[personalBoard] pending submission failed', board.id, idx, error.message);
		if (paths.length) await sb.storage.from(BINGO_BUCKET).remove(paths);
		return { ok: false, reason: 'upload_failed', error: 'Could not save your submission' };
	}
	return { ok: true };
}
