// Gielinor Catan rules — pure functions over a GameSnapshot. No DB access here; the
// server store (src/lib/server/catan/) loads rows, builds a snapshot, and applies these.
// Ruleset: docs/GIELINOR-CATAN.md.

import {
	boardHexes,
	edgeEndpoints,
	edgeId,
	hexCorners,
	hexId,
	vertexEdges,
	vertexHexes,
	vertexNeighbors,
	type EdgeId,
	type HexId,
	type VertexId
} from './geometry';
import type { Board, TileType } from './board';

export type TokenType = TileType | 'gold';
export type PieceKind = 'road' | 'settlement' | 'city';
export type DevCardType = 'pker' | 'vp' | 'bond' | 'birdhouse' | 'shortcut';

export interface Tokens {
	boss: number;
	skilling: number;
	raids: number;
	custom: number;
	gold: number;
}

export interface Team {
	id: string;
	name: string;
	color: string;
	tokens: Tokens;
	freeRoads: number; // pending free roads from Agility Shortcut cards
}

export interface Piece {
	teamId: string;
	kind: PieceKind;
	loc: string; // VertexId for settlement/city, EdgeId for road
}

export interface DevCard {
	id: string;
	teamId: string;
	card: DevCardType;
	playedAt: string | null;
}

export interface Freeze {
	loc: VertexId;
	byTeam: string;
	until: string; // ISO timestamp
}

export interface GameSnapshot {
	board: Board;
	teams: Team[];
	pieces: Piece[];
	devCards: DevCard[];
	holders: { longestRoad: string | null; largestArmy: string | null };
	freezes: Freeze[];
}

export const ZERO_TOKENS: Tokens = { boss: 0, skilling: 0, raids: 0, custom: 0, gold: 0 };

/** Build costs (§6). */
export const COSTS: Record<'road' | 'settlement' | 'city' | 'dev', Partial<Tokens>> = {
	road: { skilling: 1, custom: 1 },
	settlement: { boss: 1, skilling: 1, custom: 1 },
	city: { raids: 2, skilling: 2 },
	dev: { boss: 1, skilling: 1, custom: 1 }
};

/** Development deck composition (§9) — 25 cards. */
export const DEV_DECK: Record<DevCardType, number> = {
	pker: 14,
	vp: 5,
	bond: 2,
	birdhouse: 2,
	shortcut: 2
};

export const DEV_CARD_LABEL: Record<DevCardType, string> = {
	pker: 'PKer',
	vp: 'Hidden VP',
	bond: 'Bond',
	birdhouse: 'Birdhouse Run',
	shortcut: 'Agility Shortcut'
};

export const SETUP_SETTLEMENTS = 2;
export const SETUP_ROADS = 2;
export const WINNING_VP = 10;
export const LONGEST_ROAD_MIN = 5;
export const LARGEST_ARMY_MIN = 3;
export const PKER_FREEZE_HOURS = 24;
export const GOLD_RATE = 2; // 2 gold → 1 any token
export const BANK_RATE = 4; // 4 identical → 1 any token

export function canAfford(tokens: Tokens, cost: Partial<Tokens>): boolean {
	return (Object.entries(cost) as [TokenType, number][]).every(([t, n]) => tokens[t] >= n);
}

export function subtractCost(tokens: Tokens, cost: Partial<Tokens>): Tokens {
	const out = { ...tokens };
	for (const [t, n] of Object.entries(cost) as [TokenType, number][]) out[t] -= n;
	return out;
}

// ---- occupancy helpers ----

function buildings(snap: GameSnapshot): Piece[] {
	return snap.pieces.filter((p) => p.kind !== 'road');
}

export function buildingAt(snap: GameSnapshot, vertex: VertexId): Piece | undefined {
	return buildings(snap).find((p) => p.loc === vertex);
}

export function roadAt(snap: GameSnapshot, edge: EdgeId): Piece | undefined {
	return snap.pieces.find((p) => p.kind === 'road' && p.loc === edge);
}

function teamRoads(snap: GameSnapshot, teamId: string): EdgeId[] {
	return snap.pieces.filter((p) => p.kind === 'road' && p.teamId === teamId).map((p) => p.loc);
}

function teamBuildings(snap: GameSnapshot, teamId: string): Piece[] {
	return buildings(snap).filter((p) => p.teamId === teamId);
}

/** Setup phase: a team still owes free placements until it has 2 settlements + 2 roads. */
export function setupRemaining(snap: GameSnapshot, teamId: string) {
	const settlements = teamBuildings(snap, teamId).length;
	const roads = teamRoads(snap, teamId).length;
	return {
		settlements: Math.max(0, SETUP_SETTLEMENTS - settlements),
		roads: Math.max(0, SETUP_ROADS - roads)
	};
}

export interface SetupState {
	teamId: string;
	expect: 'settlement' | 'road';
	round: 1 | 2;
	pick: number; // 0-based completed-turn count (turn = settlement + road)
}

/**
 * The setup snake draft (Catan standard): in team order each team places 1 settlement +
 * 1 road, then the order REVERSES for the second placement. Null once every team has its
 * 2 + 2. Derived statelessly from the pieces: during setup every road on the board is a
 * setup road, so completed turns = total roads.
 */
export function setupState(snap: GameSnapshot): SetupState | null {
	const n = snap.teams.length;
	const allDone = snap.teams.every((t) => {
		const rem = setupRemaining(snap, t.id);
		return rem.settlements === 0 && rem.roads === 0;
	});
	if (allDone) return null;
	const k = snap.pieces.filter((p) => p.kind === 'road').length;
	const round: 1 | 2 = k < n ? 1 : 2;
	const team = snap.teams[k < n ? k : 2 * n - 1 - k];
	const settlements = teamBuildings(snap, team.id).length;
	const expect = settlements <= (round === 1 ? 0 : 1) ? 'settlement' : 'road';
	return { teamId: team.id, expect, round, pick: k };
}

/**
 * During setup, a team's road must attach to the settlement it just placed — i.e. its
 * settlement that has no road of theirs next to it yet (Catan's second-road rule).
 */
function freshSettlementVertex(snap: GameSnapshot, teamId: string): VertexId | null {
	for (const b of teamBuildings(snap, teamId)) {
		if (b.kind !== 'settlement') continue;
		if (vertexEdges(b.loc).every((e) => roadAt(snap, e)?.teamId !== teamId)) return b.loc;
	}
	return null;
}

// ---- placement validation ----

const onBoardVertex = (board: Board, v: VertexId) =>
	vertexHexes(v).some((h) => board.tiles[hexId(h.q, h.r)]);

const onBoardEdge = (board: Board, e: EdgeId) => {
	const [a, b] = edgeEndpoints(e);
	return (
		onBoardVertex(board, a) &&
		onBoardVertex(board, b) &&
		vertexNeighbors(a).includes(b)
	);
};

export function canPlaceSettlement(
	snap: GameSnapshot,
	teamId: string,
	vertex: VertexId
): { ok: true; free: boolean } | { ok: false; reason: string } {
	if (!onBoardVertex(snap.board, vertex)) return { ok: false, reason: 'Not a board corner.' };
	if (buildingAt(snap, vertex)) return { ok: false, reason: 'Corner is occupied.' };
	// Distance rule: no building (any team's, including your own) on an adjacent corner.
	if (vertexNeighbors(vertex).some((n) => buildingAt(snap, n)))
		return { ok: false, reason: 'Too close to another settlement (distance rule).' };

	const setup = setupState(snap);
	if (setup) {
		if (setup.teamId !== teamId) {
			const name = snap.teams.find((t) => t.id === setup.teamId)?.name ?? 'another team';
			return { ok: false, reason: `Setup draft: it's ${name}'s turn.` };
		}
		if (setup.expect !== 'settlement')
			return { ok: false, reason: 'Setup draft: place your road first.' };
		return { ok: true, free: true };
	}

	// Post-setup: must sit on your own road network, and costs 1B + 1S + 1C.
	const touchesOwnRoad = vertexEdges(vertex).some((e) => roadAt(snap, e)?.teamId === teamId);
	if (!touchesOwnRoad) return { ok: false, reason: 'Must connect to your road network.' };
	const team = snap.teams.find((t) => t.id === teamId);
	if (!team || !canAfford(team.tokens, COSTS.settlement))
		return { ok: false, reason: 'Cannot afford a settlement (1B + 1S + 1C).' };
	return { ok: true, free: false };
}

export function canPlaceRoad(
	snap: GameSnapshot,
	teamId: string,
	edge: EdgeId
): { ok: true; free: boolean } | { ok: false; reason: string } {
	if (!onBoardEdge(snap.board, edge)) return { ok: false, reason: 'Not a board edge.' };
	if (roadAt(snap, edge)) return { ok: false, reason: 'Edge already has a road.' };

	const setup = setupState(snap);
	if (setup) {
		if (setup.teamId !== teamId) {
			const name = snap.teams.find((t) => t.id === setup.teamId)?.name ?? 'another team';
			return { ok: false, reason: `Setup draft: it's ${name}'s turn.` };
		}
		if (setup.expect !== 'road')
			return { ok: false, reason: 'Setup draft: place your settlement first.' };
		const fresh = freshSettlementVertex(snap, teamId);
		if (!fresh || !edgeEndpoints(edge).includes(fresh))
			return { ok: false, reason: 'Setup road must connect to the settlement you just placed.' };
		return { ok: true, free: true };
	}

	// Must connect to your network: an endpoint with your building, or an endpoint reached
	// by one of your roads — but a rival building on the shared corner blocks pass-through.
	const connects = edgeEndpoints(edge).some((v) => {
		const b = buildingAt(snap, v);
		if (b?.teamId === teamId) return true;
		if (b && b.teamId !== teamId) return false; // blocked corner
		return vertexEdges(v).some((e) => e !== edge && roadAt(snap, e)?.teamId === teamId);
	});
	if (!connects) return { ok: false, reason: 'Must connect to your road network.' };

	const team = snap.teams.find((t) => t.id === teamId);
	const cardFree = (team?.freeRoads ?? 0) > 0;
	if (!cardFree) {
		if (!team || !canAfford(team.tokens, COSTS.road))
			return { ok: false, reason: 'Cannot afford a road (1S + 1C).' };
	}
	return { ok: true, free: cardFree };
}

export function canUpgradeCity(
	snap: GameSnapshot,
	teamId: string,
	vertex: VertexId
): { ok: true } | { ok: false; reason: string } {
	const b = buildingAt(snap, vertex);
	if (!b || b.teamId !== teamId) return { ok: false, reason: 'You have no settlement here.' };
	if (b.kind === 'city') return { ok: false, reason: 'Already a city.' };
	const team = snap.teams.find((t) => t.id === teamId);
	if (!team || !canAfford(team.tokens, COSTS.city))
		return { ok: false, reason: 'Cannot afford a city (2R + 2S).' };
	return { ok: true };
}

// ---- rolling & payouts ----

export function isFrozen(snap: GameSnapshot, vertex: VertexId, now: Date): Freeze | undefined {
	return snap.freezes.find((f) => f.loc === vertex && new Date(f.until) > now);
}

/** Corners a team may roll from: its settlements/cities, not currently frozen. */
export function rollableCorners(snap: GameSnapshot, teamId: string, now: Date): VertexId[] {
	return teamBuildings(snap, teamId)
		.map((p) => p.loc)
		.filter((v) => !isFrozen(snap, v, now));
}

/** The 2–3 on-board tiles a corner touches. */
export function cornerTiles(board: Board, vertex: VertexId): HexId[] {
	return vertexHexes(vertex)
		.map((h) => hexId(h.q, h.r))
		.filter((id) => board.tiles[id]);
}

/**
 * Same-type multiplier (§3): 1 token per DISTINCT tile of the task's type adjacent to the
 * team's network; a tile adjacent to one of the team's cities counts double (§6 — a city
 * doubles that corner's output). Uncapped.
 */
export function taskPayout(snap: GameSnapshot, teamId: string, type: TileType): number {
	const weight = new Map<HexId, number>();
	for (const b of teamBuildings(snap, teamId)) {
		const mult = b.kind === 'city' ? 2 : 1;
		for (const hid of cornerTiles(snap.board, b.loc)) {
			if (snap.board.tiles[hid].type !== type) continue;
			weight.set(hid, Math.max(weight.get(hid) ?? 0, mult));
		}
	}
	let total = 0;
	for (const w of weight.values()) total += w;
	return total;
}

/** Distinct adjacent tile counts per type — the team's "engine" summary. */
export function networkTileCounts(snap: GameSnapshot, teamId: string): Record<TileType, number> {
	const counts: Record<TileType, number> = { boss: 0, skilling: 0, raids: 0, custom: 0 };
	const seen = new Set<HexId>();
	for (const b of teamBuildings(snap, teamId)) {
		for (const hid of cornerTiles(snap.board, b.loc)) {
			if (seen.has(hid)) continue;
			seen.add(hid);
			counts[snap.board.tiles[hid].type]++;
		}
	}
	return counts;
}

// ---- trading ----

/** Best "give N identical of type T for 1 any" rate available to a team (bank + its ports). */
export function tradeRates(snap: GameSnapshot, teamId: string): Record<TileType, number> {
	const rates: Record<TileType, number> = { boss: BANK_RATE, skilling: BANK_RATE, raids: BANK_RATE, custom: BANK_RATE };
	const owned = new Set(teamBuildings(snap, teamId).map((p) => p.loc));
	for (const port of snap.board.ports) {
		if (!port.vertices.some((v) => owned.has(v))) continue;
		if (port.kind === 'generic') {
			for (const t of Object.keys(rates) as TileType[]) rates[t] = Math.min(rates[t], 3);
		} else {
			rates[port.kind] = Math.min(rates[port.kind], 2);
		}
	}
	return rates;
}

// ---- longest road ----

/** Longest continuous road for a team; rival buildings break the path at that corner. */
export function longestRoadLength(snap: GameSnapshot, teamId: string): number {
	const roads = new Set(teamRoads(snap, teamId));
	if (roads.size === 0) return 0;

	const blocked = (v: VertexId) => {
		const b = buildingAt(snap, v);
		return !!b && b.teamId !== teamId;
	};

	let best = 0;
	const walk = (v: VertexId, used: Set<EdgeId>) => {
		best = Math.max(best, used.size);
		if (blocked(v) && used.size > 0) return; // can't continue through a rival building
		for (const e of vertexEdges(v)) {
			if (!roads.has(e) || used.has(e)) continue;
			const [a, b] = edgeEndpoints(e);
			used.add(e);
			walk(a === v ? b : a, used);
			used.delete(e);
		}
	};
	for (const e of roads) {
		for (const v of edgeEndpoints(e)) walk(v, new Set());
	}
	return best;
}

/** PKer cards played per team (Largest Army / "Bounty Hunter" race). */
export function armySize(snap: GameSnapshot, teamId: string): number {
	return snap.devCards.filter((c) => c.teamId === teamId && c.card === 'pker' && c.playedAt).length;
}

/**
 * Recompute stealable-bonus holders after a state change. Catan semantics: the current
 * holder keeps the title until someone STRICTLY exceeds them (ties don't steal).
 */
export function updateHolders(snap: GameSnapshot): GameSnapshot['holders'] {
	return {
		longestRoad: nextHolder(snap.holders.longestRoad, snap.teams, (t) => longestRoadLength(snap, t.id), LONGEST_ROAD_MIN),
		largestArmy: nextHolder(snap.holders.largestArmy, snap.teams, (t) => armySize(snap, t.id), LARGEST_ARMY_MIN)
	};
}

function nextHolder(
	current: string | null,
	teams: Team[],
	metric: (t: Team) => number,
	min: number
): string | null {
	const scores = new Map(teams.map((t) => [t.id, metric(t)]));
	// Current holder loses the title outright if they drop below the minimum.
	let bar = current ? Math.max(scores.get(current) ?? 0, min - 1) : min - 1;
	if (current && (scores.get(current) ?? 0) < min) {
		current = null;
		bar = min - 1;
	}
	let holder = current;
	for (const t of teams) {
		const s = scores.get(t.id) ?? 0;
		if (s > bar) {
			holder = t.id;
			bar = s;
		}
	}
	return holder;
}

// ---- victory points ----

export interface VPBreakdown {
	settlements: number;
	cities: number;
	longestRoad: boolean;
	largestArmy: boolean;
	hiddenVP: number;
	total: number;
}

export function teamVP(snap: GameSnapshot, teamId: string, opts: { includeHidden: boolean }): VPBreakdown {
	const b = teamBuildings(snap, teamId);
	const settlements = b.filter((p) => p.kind === 'settlement').length;
	const cities = b.filter((p) => p.kind === 'city').length;
	const longestRoad = snap.holders.longestRoad === teamId;
	const largestArmy = snap.holders.largestArmy === teamId;
	const hiddenVP = opts.includeHidden
		? snap.devCards.filter((c) => c.teamId === teamId && c.card === 'vp').length
		: 0;
	const total = settlements + cities * 2 + (longestRoad ? 2 : 0) + (largestArmy ? 2 : 0) + hiddenVP;
	return { settlements, cities, longestRoad, largestArmy, hiddenVP, total };
}

/** Build the full shuffled dev deck for a new game (server shuffles with its own RNG). */
export function freshDeck(): DevCardType[] {
	return (Object.entries(DEV_DECK) as [DevCardType, number][]).flatMap(([card, n]) =>
		Array<DevCardType>(n).fill(card)
	);
}

/** Vertices legal for a team's next settlement right now (for UI highlighting). */
export function legalSettlementSpots(snap: GameSnapshot, teamId: string): VertexId[] {
	const hexes = boardHexes(snap.board.radius);
	const seen = new Set<VertexId>();
	const out: VertexId[] = [];
	for (const h of hexes) {
		for (const v of hexCorners(h)) {
			if (seen.has(v)) continue;
			seen.add(v);
			if (canPlaceSettlement(snap, teamId, v).ok) out.push(v);
		}
	}
	return out;
}

/** Edges legal for a team's next road right now (for UI highlighting). */
export function legalRoadSpots(snap: GameSnapshot, teamId: string): EdgeId[] {
	const hexes = boardHexes(snap.board.radius);
	const seen = new Set<EdgeId>();
	const out: EdgeId[] = [];
	for (const h of hexes) {
		const corners = hexCorners(h);
		for (let i = 0; i < 6; i++) {
			const e = edgeId(corners[i], corners[(i + 1) % 6]);
			if (seen.has(e)) continue;
			seen.add(e);
			if (canPlaceRoad(snap, teamId, e).ok) out.push(e);
		}
	}
	return out;
}
