// Gielinor Catan — server store + actions for the MVP tester (docs/GIELINOR-CATAN.md).
//
// The game container is a vs_events row (kind='catan', status='draft' so the bot's
// event-announce poller and public lists ignore it). The generated board, remaining dev
// deck, stealable-bonus holders and PKer freezes live in vs_events.structure.catan;
// per-team state lives in vs_catan_teams / vs_catan_pieces / vs_catan_dev_cards /
// vs_catan_tasks, with every action appended to vs_catan_log.
//
// Rules live in src/lib/catan/rules.ts (pure); this module loads rows, builds a
// GameSnapshot, validates through the rules, then writes. Single-admin tester → plain
// read-modify-write is fine; revisit concurrency when real teams act simultaneously.

import { db } from './db';
import { generateBoard, type Board, type TileType } from '$lib/catan/board';
import {
	armySize,
	canPlaceRoad,
	canPlaceSettlement,
	canUpgradeCity,
	cornerTiles,
	COSTS,
	canAfford,
	freshDeck,
	GOLD_RATE,
	isFrozen,
	legalRoadSpots,
	legalSettlementSpots,
	longestRoadLength,
	networkTileCounts,
	PKER_FREEZE_HOURS,
	rollableCorners,
	setupRemaining,
	subtractCost,
	taskPayout,
	teamVP,
	tradeRates,
	updateHolders,
	WINNING_VP,
	ZERO_TOKENS,
	type DevCardType,
	type Freeze,
	type GameSnapshot,
	type Team,
	type Tokens
} from '$lib/catan/rules';

export type ActionResult = { ok: true } | { ok: false; error: string };

interface CatanStructure {
	board: Board;
	deck: DevCardType[];
	holders: { longestRoad: string | null; largestArmy: string | null };
	freezes: Freeze[];
}

interface EventRow {
	id: string;
	slug: string;
	name: string;
	status: string;
	structure: { catan: CatanStructure };
	created_at: string;
}

interface TeamRow {
	id: string;
	event_id: string;
	position: number;
	name: string;
	color: string;
	tokens: Tokens;
	free_roads: number;
}

interface PieceRow {
	id: string;
	team_id: string;
	kind: 'road' | 'settlement' | 'city';
	loc: string;
}

interface DevCardRow {
	id: string;
	team_id: string;
	card: DevCardType;
	drawn_at: string;
	played_at: string | null;
	meta: Record<string, unknown>;
}

export interface TaskRow {
	id: string;
	team_id: string;
	vertex: string;
	hex: string;
	task: { label: string; unit: string; amount: number; type: TileType; rating: number };
	status: 'active' | 'completed' | 'abandoned';
	payout: Record<string, number> | null;
	rolled_at: string;
	completed_at: string | null;
}

export interface LogRow {
	id: string;
	team_id: string | null;
	action: string;
	detail: Record<string, unknown>;
	created_at: string;
}

const TEAM_PRESETS: { name: string; color: string }[] = [
	{ name: 'Team Red', color: '#e05b4b' },
	{ name: 'Team Blue', color: '#4b8de0' },
	{ name: 'Team Green', color: '#57b85a' },
	{ name: 'Team Purple', color: '#9d6fe0' },
	{ name: 'Team Orange', color: '#e09a3c' },
	{ name: 'Team Cyan', color: '#3fc2c8' },
	{ name: 'Team Pink', color: '#df6fae' },
	{ name: 'Team White', color: '#d8d3c8' }
];

const TEAM_COUNT = 8;

function shuffleInPlace<T>(a: T[]): T[] {
	for (let i = a.length - 1; i > 0; i--) {
		const j = Math.floor(Math.random() * (i + 1));
		[a[i], a[j]] = [a[j], a[i]];
	}
	return a;
}

// ---- game lifecycle ----

export async function listGames(): Promise<
	{ id: string; slug: string; name: string; status: string; created_at: string }[]
> {
	const { data } = await db()
		.from('vs_events')
		.select('id, slug, name, status, created_at')
		.eq('kind', 'catan')
		.order('created_at', { ascending: false });
	return (data ?? []) as { id: string; slug: string; name: string; status: string; created_at: string }[];
}

export async function createGame(
	name: string,
	ownerUserId: string,
	seed?: number
): Promise<{ ok: true; slug: string } | { ok: false; error: string }> {
	const boardSeed = seed ?? Math.floor(Math.random() * 2 ** 31);
	const board = generateBoard(boardSeed);
	const structure: { catan: CatanStructure } = {
		catan: {
			board,
			deck: shuffleInPlace(freshDeck()),
			holders: { longestRoad: null, largestArmy: null },
			freezes: []
		}
	};
	const slug = `catan-${Date.now().toString(36)}`;
	const { data: ev, error: evErr } = await db()
		.from('vs_events')
		.insert({
			slug,
			name,
			kind: 'catan',
			// 'draft' keeps test games out of public event lists and away from the bot's
			// event-announce poller (which posts status='open' events to Discord).
			status: 'draft',
			owner_user_id: ownerUserId,
			team_size: 4,
			structure
		})
		.select('id')
		.single();
	if (evErr || !ev) return { ok: false, error: evErr?.message ?? 'Could not create game' };

	const teams = TEAM_PRESETS.slice(0, TEAM_COUNT).map((t, i) => ({
		event_id: ev.id,
		position: i + 1,
		name: t.name,
		color: t.color,
		tokens: { ...ZERO_TOKENS }
	}));
	const { error: teamErr } = await db().from('vs_catan_teams').insert(teams);
	if (teamErr) {
		await db().from('vs_events').delete().eq('id', ev.id); // roll back the orphan
		return { ok: false, error: teamErr.message };
	}
	await log(ev.id, null, 'game_created', { seed: boardSeed, teams: TEAM_COUNT });
	return { ok: true, slug };
}

export async function deleteGame(eventId: string): Promise<ActionResult> {
	const { error } = await db().from('vs_events').delete().eq('id', eventId).eq('kind', 'catan');
	return error ? { ok: false, error: error.message } : { ok: true };
}

// ---- loading ----

export interface GameView {
	eventId: string;
	slug: string;
	name: string;
	status: string;
	board: Board;
	deckRemaining: number;
	snapshot: GameSnapshot;
	teams: (Team & {
		position: number;
		setup: { settlements: number; roads: number };
		vp: ReturnType<typeof teamVP>;
		publicVP: number;
		network: Record<TileType, number>;
		rates: Record<TileType, number>;
		longestRoad: number;
		army: number;
		rollable: string[];
		legalSettlements: string[];
		legalRoads: string[];
		devCards: DevCardRow[];
	})[];
	pieces: PieceRow[];
	activeTasks: TaskRow[];
	recentTasks: TaskRow[];
	log: LogRow[];
	freezes: Freeze[];
	winner: { teamId: string; name: string } | null;
}

async function loadRows(slug: string) {
	const { data: ev } = await db()
		.from('vs_events')
		.select('id, slug, name, status, structure, created_at')
		.eq('slug', slug)
		.eq('kind', 'catan')
		.maybeSingle();
	if (!ev?.structure?.catan) return null;
	const eventId = (ev as EventRow).id;
	const [teams, pieces, cards, tasks, logs] = await Promise.all([
		db().from('vs_catan_teams').select('*').eq('event_id', eventId).order('position'),
		db().from('vs_catan_pieces').select('id, team_id, kind, loc').eq('event_id', eventId),
		db().from('vs_catan_dev_cards').select('id, team_id, card, drawn_at, played_at, meta').eq('event_id', eventId),
		db()
			.from('vs_catan_tasks')
			.select('id, team_id, vertex, hex, task, status, payout, rolled_at, completed_at')
			.eq('event_id', eventId)
			.order('rolled_at', { ascending: false })
			.limit(200),
		db()
			.from('vs_catan_log')
			.select('id, team_id, action, detail, created_at')
			.eq('event_id', eventId)
			.order('created_at', { ascending: false })
			.limit(60)
	]);
	return {
		ev: ev as EventRow,
		teams: (teams.data ?? []) as TeamRow[],
		pieces: (pieces.data ?? []) as PieceRow[],
		cards: (cards.data ?? []) as DevCardRow[],
		tasks: (tasks.data ?? []) as TaskRow[],
		logs: (logs.data ?? []) as LogRow[]
	};
}

function buildSnapshot(ev: EventRow, teams: TeamRow[], pieces: PieceRow[], cards: DevCardRow[]): GameSnapshot {
	const cat = ev.structure.catan;
	return {
		board: cat.board,
		teams: teams.map((t) => ({
			id: t.id,
			name: t.name,
			color: t.color,
			tokens: { ...ZERO_TOKENS, ...t.tokens },
			freeRoads: t.free_roads
		})),
		pieces: pieces.map((p) => ({ teamId: p.team_id, kind: p.kind, loc: p.loc })),
		devCards: cards.map((c) => ({ id: c.id, teamId: c.team_id, card: c.card, playedAt: c.played_at })),
		holders: cat.holders,
		freezes: cat.freezes
	};
}

/** Full tester view of a game. Read — fails open (null) so the page still renders. */
export async function loadGame(slug: string): Promise<GameView | null> {
	const rows = await loadRows(slug);
	if (!rows) return null;
	const { ev, teams, pieces, cards, tasks, logs } = rows;
	const snap = buildSnapshot(ev, teams, pieces, cards);
	const now = new Date();
	const cat = ev.structure.catan;

	const teamViews = teams.map((t) => {
		const vp = teamVP(snap, t.id, { includeHidden: true });
		return {
			id: t.id,
			name: t.name,
			color: t.color,
			tokens: { ...ZERO_TOKENS, ...t.tokens },
			freeRoads: t.free_roads,
			position: t.position,
			setup: setupRemaining(snap, t.id),
			vp,
			publicVP: vp.total - vp.hiddenVP,
			network: networkTileCounts(snap, t.id),
			rates: tradeRates(snap, t.id),
			longestRoad: longestRoadLength(snap, t.id),
			army: armySize(snap, t.id),
			rollable: rollableCorners(snap, t.id, now),
			legalSettlements: legalSettlementSpots(snap, t.id),
			legalRoads: legalRoadSpots(snap, t.id),
			devCards: cards.filter((c) => c.team_id === t.id)
		};
	});
	const winnerTeam = teamViews.find((t) => t.vp.total >= WINNING_VP) ?? null;

	return {
		eventId: ev.id,
		slug: ev.slug,
		name: ev.name,
		status: ev.status,
		board: cat.board,
		deckRemaining: cat.deck.length,
		snapshot: snap,
		teams: teamViews,
		pieces,
		activeTasks: tasks.filter((t) => t.status === 'active'),
		recentTasks: tasks.filter((t) => t.status !== 'active').slice(0, 20),
		log: logs,
		freezes: cat.freezes.filter((f) => new Date(f.until) > now),
		winner: winnerTeam ? { teamId: winnerTeam.id, name: winnerTeam.name } : null
	};
}

// ---- shared write helpers ----

async function log(eventId: string, teamId: string | null, action: string, detail: Record<string, unknown>) {
	await db().from('vs_catan_log').insert({ event_id: eventId, team_id: teamId, action, detail });
}

async function saveTokens(teamId: string, tokens: Tokens): Promise<ActionResult> {
	const { error } = await db().from('vs_catan_teams').update({ tokens }).eq('id', teamId);
	return error ? { ok: false, error: error.message } : { ok: true };
}

async function saveStructure(ev: EventRow): Promise<ActionResult> {
	const { error } = await db().from('vs_events').update({ structure: ev.structure }).eq('id', ev.id);
	return error ? { ok: false, error: error.message } : { ok: true };
}

async function refreshHolders(ev: EventRow): Promise<ActionResult> {
	const rows = await loadRows(ev.slug);
	if (!rows) return { ok: false, error: 'Game vanished' };
	const snap = buildSnapshot(rows.ev, rows.teams, rows.pieces, rows.cards);
	const holders = updateHolders(snap);
	const prev = rows.ev.structure.catan.holders;
	if (holders.longestRoad === prev.longestRoad && holders.largestArmy === prev.largestArmy) return { ok: true };
	rows.ev.structure.catan.holders = holders;
	if (holders.longestRoad !== prev.longestRoad)
		await log(ev.id, holders.longestRoad, 'longest_road', { from: prev.longestRoad, to: holders.longestRoad });
	if (holders.largestArmy !== prev.largestArmy)
		await log(ev.id, holders.largestArmy, 'largest_army', { from: prev.largestArmy, to: holders.largestArmy });
	return saveStructure(rows.ev);
}

interface Ctx {
	ev: EventRow;
	teams: TeamRow[];
	snap: GameSnapshot;
	team: TeamRow;
}

async function withTeam(slug: string, teamId: string): Promise<Ctx | { error: string }> {
	const rows = await loadRows(slug);
	if (!rows) return { error: 'Game not found' };
	const team = rows.teams.find((t) => t.id === teamId);
	if (!team) return { error: 'Team not found' };
	return {
		ev: rows.ev,
		teams: rows.teams,
		snap: buildSnapshot(rows.ev, rows.teams, rows.pieces, rows.cards),
		team
	};
}

const tokensOf = (t: TeamRow): Tokens => ({ ...ZERO_TOKENS, ...t.tokens });

// ---- build actions ----

export async function placeSettlement(slug: string, teamId: string, vertex: string): Promise<ActionResult> {
	const ctx = await withTeam(slug, teamId);
	if ('error' in ctx) return { ok: false, error: ctx.error };
	const verdict = canPlaceSettlement(ctx.snap, teamId, vertex);
	if (!verdict.ok) return { ok: false, error: verdict.reason };

	const { error } = await db()
		.from('vs_catan_pieces')
		.insert({ event_id: ctx.ev.id, team_id: teamId, kind: 'settlement', loc: vertex });
	if (error) return { ok: false, error: error.message };
	if (!verdict.free) {
		const r = await saveTokens(teamId, subtractCost(tokensOf(ctx.team), COSTS.settlement));
		if (!r.ok) return r;
	}
	await log(ctx.ev.id, teamId, 'settlement', { vertex, free: verdict.free });
	return refreshHolders(ctx.ev); // a new settlement can cut a rival's longest road
}

export async function placeRoad(slug: string, teamId: string, edge: string): Promise<ActionResult> {
	const ctx = await withTeam(slug, teamId);
	if ('error' in ctx) return { ok: false, error: ctx.error };
	const verdict = canPlaceRoad(ctx.snap, teamId, edge);
	if (!verdict.ok) return { ok: false, error: verdict.reason };

	const { error } = await db()
		.from('vs_catan_pieces')
		.insert({ event_id: ctx.ev.id, team_id: teamId, kind: 'road', loc: edge });
	if (error) return { ok: false, error: error.message };

	const setupFree = setupRemaining(ctx.snap, teamId).roads > 0;
	if (!setupFree && ctx.team.free_roads > 0) {
		await db().from('vs_catan_teams').update({ free_roads: ctx.team.free_roads - 1 }).eq('id', teamId);
	} else if (!setupFree) {
		const r = await saveTokens(teamId, subtractCost(tokensOf(ctx.team), COSTS.road));
		if (!r.ok) return r;
	}
	await log(ctx.ev.id, teamId, 'road', { edge, free: verdict.free });
	return refreshHolders(ctx.ev);
}

export async function upgradeCity(slug: string, teamId: string, vertex: string): Promise<ActionResult> {
	const ctx = await withTeam(slug, teamId);
	if ('error' in ctx) return { ok: false, error: ctx.error };
	const verdict = canUpgradeCity(ctx.snap, teamId, vertex);
	if (!verdict.ok) return { ok: false, error: verdict.reason };

	const { error } = await db()
		.from('vs_catan_pieces')
		.update({ kind: 'city' })
		.eq('event_id', ctx.ev.id)
		.eq('team_id', teamId)
		.eq('loc', vertex);
	if (error) return { ok: false, error: error.message };
	const r = await saveTokens(teamId, subtractCost(tokensOf(ctx.team), COSTS.city));
	if (!r.ok) return r;
	await log(ctx.ev.id, teamId, 'city', { vertex });
	return { ok: true };
}

// ---- tasks (§3 rolling) ----

export async function rollTask(slug: string, teamId: string, vertex: string): Promise<ActionResult> {
	const ctx = await withTeam(slug, teamId);
	if ('error' in ctx) return { ok: false, error: ctx.error };
	if (!rollableCorners(ctx.snap, teamId, new Date()).includes(vertex))
		return { ok: false, error: 'Not one of your (unfrozen) corners.' };

	const tiles = cornerTiles(ctx.snap.board, vertex);
	const hex = tiles[Math.floor(Math.random() * tiles.length)];
	const tile = ctx.snap.board.tiles[hex];
	const task = tile.tasks[Math.floor(Math.random() * tile.tasks.length)];

	const { error } = await db().from('vs_catan_tasks').insert({
		event_id: ctx.ev.id,
		team_id: teamId,
		vertex,
		hex,
		task: { ...task, type: tile.type, rating: tile.rating }
	});
	if (error) return { ok: false, error: error.message };
	await log(ctx.ev.id, teamId, 'task_rolled', { vertex, hex, type: tile.type, rating: tile.rating, task: task.label });
	return { ok: true };
}

export async function completeTask(slug: string, teamId: string, taskId: string): Promise<ActionResult> {
	const ctx = await withTeam(slug, teamId);
	if ('error' in ctx) return { ok: false, error: ctx.error };
	const { data: task } = await db()
		.from('vs_catan_tasks')
		.select('id, team_id, task, status')
		.eq('id', taskId)
		.eq('event_id', ctx.ev.id)
		.maybeSingle();
	if (!task || task.team_id !== teamId) return { ok: false, error: 'Task not found' };
	if (task.status !== 'active') return { ok: false, error: 'Task is not active' };

	const type = (task.task as TaskRow['task']).type;
	// §3 same-type multiplier, computed at completion time against the current network.
	const amount = Math.max(1, taskPayout(ctx.snap, teamId, type));
	const payout = { [type]: amount };

	const { error } = await db()
		.from('vs_catan_tasks')
		.update({ status: 'completed', payout, completed_at: new Date().toISOString() })
		.eq('id', taskId)
		.eq('status', 'active');
	if (error) return { ok: false, error: error.message };

	const tokens = tokensOf(ctx.team);
	tokens[type] += amount;
	const r = await saveTokens(teamId, tokens);
	if (!r.ok) return r;
	await log(ctx.ev.id, teamId, 'task_completed', { taskId, type, amount });
	return { ok: true };
}

export async function abandonTask(slug: string, teamId: string, taskId: string): Promise<ActionResult> {
	const ctx = await withTeam(slug, teamId);
	if ('error' in ctx) return { ok: false, error: ctx.error };
	const { error } = await db()
		.from('vs_catan_tasks')
		.update({ status: 'abandoned' })
		.eq('id', taskId)
		.eq('event_id', ctx.ev.id)
		.eq('team_id', teamId)
		.eq('status', 'active');
	if (error) return { ok: false, error: error.message };
	await log(ctx.ev.id, teamId, 'task_abandoned', { taskId });
	return { ok: true };
}

// ---- economy ----

/** Tester cheat: grant arbitrary tokens/gold (simulates drops, gold tasks, fast-forward). */
export async function grantTokens(slug: string, teamId: string, grant: Partial<Tokens>): Promise<ActionResult> {
	const ctx = await withTeam(slug, teamId);
	if ('error' in ctx) return { ok: false, error: ctx.error };
	const tokens = tokensOf(ctx.team);
	for (const [k, v] of Object.entries(grant) as [keyof Tokens, number][]) {
		tokens[k] = Math.max(0, tokens[k] + v);
	}
	const r = await saveTokens(teamId, tokens);
	if (!r.ok) return r;
	await log(ctx.ev.id, teamId, 'grant', { ...grant });
	return { ok: true };
}

/** Gold exchange (§5): 2 gold → 1 token of any type. */
export async function exchangeGold(slug: string, teamId: string, get: TileType, count: number): Promise<ActionResult> {
	if (count < 1) return { ok: false, error: 'Count must be positive' };
	const ctx = await withTeam(slug, teamId);
	if ('error' in ctx) return { ok: false, error: ctx.error };
	const tokens = tokensOf(ctx.team);
	const cost = GOLD_RATE * count;
	if (tokens.gold < cost) return { ok: false, error: `Needs ${cost} gold` };
	tokens.gold -= cost;
	tokens[get] += count;
	const r = await saveTokens(teamId, tokens);
	if (!r.ok) return r;
	await log(ctx.ev.id, teamId, 'gold_exchange', { get, count, gold: cost });
	return { ok: true };
}

/** Bank/port trade (§7): N identical → 1 any, at the team's best available rate. */
export async function bankTrade(slug: string, teamId: string, give: TileType, get: TileType, count: number): Promise<ActionResult> {
	if (count < 1) return { ok: false, error: 'Count must be positive' };
	if (give === get) return { ok: false, error: 'Pick two different token types' };
	const ctx = await withTeam(slug, teamId);
	if ('error' in ctx) return { ok: false, error: ctx.error };
	const rate = tradeRates(ctx.snap, teamId)[give];
	const tokens = tokensOf(ctx.team);
	const cost = rate * count;
	if (tokens[give] < cost) return { ok: false, error: `Needs ${cost} ${give} (rate ${rate}:1)` };
	tokens[give] -= cost;
	tokens[get] += count;
	const r = await saveTokens(teamId, tokens);
	if (!r.ok) return r;
	await log(ctx.ev.id, teamId, 'bank_trade', { give, get, count, rate });
	return { ok: true };
}

// ---- development cards (§9) ----

export async function drawDevCard(slug: string, teamId: string): Promise<ActionResult> {
	const ctx = await withTeam(slug, teamId);
	if ('error' in ctx) return { ok: false, error: ctx.error };
	const cat = ctx.ev.structure.catan;
	if (cat.deck.length === 0) return { ok: false, error: 'The development deck is empty' };
	const tokens = tokensOf(ctx.team);
	if (!canAfford(tokens, COSTS.dev)) return { ok: false, error: 'Cannot afford a dev card (1B + 1S + 1C)' };

	const card = cat.deck[Math.floor(Math.random() * cat.deck.length)];
	cat.deck.splice(cat.deck.indexOf(card), 1);

	const { error } = await db()
		.from('vs_catan_dev_cards')
		.insert({ event_id: ctx.ev.id, team_id: teamId, card });
	if (error) return { ok: false, error: error.message };
	const rs = await saveStructure(ctx.ev);
	if (!rs.ok) return rs;
	const rt = await saveTokens(teamId, subtractCost(tokens, COSTS.dev));
	if (!rt.ok) return rt;
	// The drawn card is logged without naming it — hidden information stays hidden in the
	// log; the tester sees each team's hand in that team's own panel.
	await log(ctx.ev.id, teamId, 'dev_drawn', { remaining: cat.deck.length });
	return { ok: true };
}

export async function playDevCard(
	slug: string,
	teamId: string,
	cardId: string,
	params: { vertex?: string; tokenType?: TileType; take?: TileType[] }
): Promise<ActionResult> {
	const ctx = await withTeam(slug, teamId);
	if ('error' in ctx) return { ok: false, error: ctx.error };
	const { data: card } = await db()
		.from('vs_catan_dev_cards')
		.select('id, team_id, card, played_at')
		.eq('id', cardId)
		.eq('event_id', ctx.ev.id)
		.maybeSingle();
	if (!card || card.team_id !== teamId) return { ok: false, error: 'Card not found' };
	if (card.played_at) return { ok: false, error: 'Card already played' };

	const meta: Record<string, unknown> = {};
	const cat = ctx.ev.structure.catan;

	switch (card.card as DevCardType) {
		case 'vp':
			return { ok: false, error: 'Hidden VP cards are revealed at game end, not played.' };

		case 'pker': {
			// Freeze a rival corner for PKER_FREEZE_HOURS (§9).
			const vertex = params.vertex;
			const target = vertex ? ctx.snap.pieces.find((p) => p.kind !== 'road' && p.loc === vertex) : undefined;
			if (!vertex || !target) return { ok: false, error: 'Pick a corner with a building on it.' };
			if (target.teamId === teamId) return { ok: false, error: 'Cannot PK your own corner.' };
			if (isFrozen(ctx.snap, vertex, new Date())) return { ok: false, error: 'Corner is already frozen.' };
			const until = new Date(Date.now() + PKER_FREEZE_HOURS * 3600_000).toISOString();
			cat.freezes = cat.freezes.filter((f) => new Date(f.until) > new Date());
			cat.freezes.push({ loc: vertex, byTeam: teamId, until });
			meta.vertex = vertex;
			meta.until = until;
			break;
		}

		case 'bond': {
			// Monopoly: every other team hands over all tokens of the named type (§9).
			const type = params.tokenType;
			if (!type) return { ok: false, error: 'Pick a token type.' };
			let collected = 0;
			for (const other of ctx.teams) {
				if (other.id === teamId) continue;
				const theirs = tokensOf(other);
				if (theirs[type] <= 0) continue;
				collected += theirs[type];
				theirs[type] = 0;
				const r = await saveTokens(other.id, theirs);
				if (!r.ok) return r;
			}
			const mine = tokensOf(ctx.team);
			mine[type] += collected;
			const r = await saveTokens(teamId, mine);
			if (!r.ok) return r;
			meta.tokenType = type;
			meta.collected = collected;
			break;
		}

		case 'birdhouse': {
			// Year of Plenty: take any 2 tokens from the bank (§9).
			const take = params.take ?? [];
			if (take.length !== 2) return { ok: false, error: 'Pick exactly two tokens.' };
			const mine = tokensOf(ctx.team);
			for (const t of take) mine[t] += 1;
			const r = await saveTokens(teamId, mine);
			if (!r.ok) return r;
			meta.take = take;
			break;
		}

		case 'shortcut': {
			// Road Building: the next 2 roads are free (§9).
			const { error } = await db()
				.from('vs_catan_teams')
				.update({ free_roads: ctx.team.free_roads + 2 })
				.eq('id', teamId);
			if (error) return { ok: false, error: error.message };
			break;
		}
	}

	const { error } = await db()
		.from('vs_catan_dev_cards')
		.update({ played_at: new Date().toISOString(), meta })
		.eq('id', cardId);
	if (error) return { ok: false, error: error.message };
	const rs = await saveStructure(ctx.ev);
	if (!rs.ok) return rs;
	await log(ctx.ev.id, teamId, 'dev_played', { card: card.card, ...meta });
	if (card.card === 'pker') return refreshHolders(ctx.ev); // army race
	return { ok: true };
}
