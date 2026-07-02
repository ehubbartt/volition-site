// Gielinor Catan — server store + actions for the MVP tester (docs/GIELINOR-CATAN.md).
//
// The game container is a vs_events row (kind='catan', status='draft' so the bot's
// event-announce poller and public lists ignore it). Deliberately table-light: only state
// needing a DB-level guarantee gets a table — vs_catan_teams (wallet row atomicity; also
// carries each team's dev-card hand + rolled tasks as jsonb) and vs_catan_pieces (the
// unique (event_id, loc) constraint IS the occupancy rule). The generated board, remaining
// dev deck, stealable-bonus holders, PKer freezes and a capped action log live in
// vs_events.structure.catan.
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

export interface HandCard {
	id: string;
	card: DevCardType;
	drawn_at: string;
	played_at: string | null;
	meta: Record<string, unknown>;
}

export interface TeamTask {
	id: string;
	vertex: string;
	hex: string;
	task: { label: string; unit: string; amount: number; type: TileType; rating: number };
	status: 'active' | 'completed' | 'abandoned';
	payout: Record<string, number> | null;
	rolled_at: string;
	completed_at: string | null;
}

export interface LogEntry {
	team_id: string | null;
	action: string;
	detail: Record<string, unknown>;
	created_at: string;
}

interface CatanStructure {
	board: Board;
	deck: DevCardType[];
	holders: { longestRoad: string | null; largestArmy: string | null };
	freezes: Freeze[];
	log: LogEntry[];
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
	hand: HandCard[];
	tasks: TeamTask[];
}

interface PieceRow {
	id: string;
	team_id: string;
	kind: 'road' | 'settlement' | 'city';
	loc: string;
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
const LOG_CAP = 200; // structure.catan.log keeps the newest LOG_CAP entries
const TASK_HISTORY_CAP = 30; // finished tasks kept per team (active ones always kept)

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
			freezes: [],
			log: [
				{ team_id: null, action: 'game_created', detail: { seed: boardSeed, teams: TEAM_COUNT }, created_at: new Date().toISOString() }
			]
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
		devCards: HandCard[];
	})[];
	pieces: PieceRow[];
	activeTasks: (TeamTask & { team_id: string })[];
	recentTasks: (TeamTask & { team_id: string })[];
	log: LogEntry[];
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
	const [teams, pieces] = await Promise.all([
		db().from('vs_catan_teams').select('*').eq('event_id', eventId).order('position'),
		db().from('vs_catan_pieces').select('id, team_id, kind, loc').eq('event_id', eventId)
	]);
	const teamRows = ((teams.data ?? []) as TeamRow[]).map((t) => ({
		...t,
		hand: t.hand ?? [],
		tasks: t.tasks ?? []
	}));
	return {
		ev: ev as EventRow,
		teams: teamRows,
		pieces: (pieces.data ?? []) as PieceRow[]
	};
}

function buildSnapshot(ev: EventRow, teams: TeamRow[], pieces: PieceRow[]): GameSnapshot {
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
		devCards: teams.flatMap((t) =>
			t.hand.map((c) => ({ id: c.id, teamId: t.id, card: c.card, playedAt: c.played_at }))
		),
		holders: cat.holders,
		freezes: cat.freezes
	};
}

/** Full tester view of a game. Read — fails open (null) so the page still renders. */
export async function loadGame(slug: string): Promise<GameView | null> {
	const rows = await loadRows(slug);
	if (!rows) return null;
	const { ev, teams, pieces } = rows;
	const snap = buildSnapshot(ev, teams, pieces);
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
			devCards: t.hand
		};
	});
	const winnerTeam = teamViews.find((t) => t.vp.total >= WINNING_VP) ?? null;

	const allTasks = teams.flatMap((t) => t.tasks.map((task) => ({ ...task, team_id: t.id })));
	allTasks.sort((a, b) => (a.rolled_at < b.rolled_at ? 1 : -1));

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
		activeTasks: allTasks.filter((t) => t.status === 'active'),
		recentTasks: allTasks.filter((t) => t.status !== 'active').slice(0, 20),
		log: [...(cat.log ?? [])].reverse().slice(0, 60),
		freezes: cat.freezes.filter((f) => new Date(f.until) > now),
		winner: winnerTeam ? { teamId: winnerTeam.id, name: winnerTeam.name } : null
	};
}

// ---- shared write helpers ----

/** Append to the capped action log in structure and persist the whole structure. */
async function logAndSave(ev: EventRow, teamId: string | null, action: string, detail: Record<string, unknown>): Promise<ActionResult> {
	const cat = ev.structure.catan;
	cat.log = [...(cat.log ?? []), { team_id: teamId, action, detail, created_at: new Date().toISOString() }].slice(-LOG_CAP);
	return saveStructure(ev);
}

async function saveStructure(ev: EventRow): Promise<ActionResult> {
	const { error } = await db().from('vs_events').update({ structure: ev.structure }).eq('id', ev.id);
	return error ? { ok: false, error: error.message } : { ok: true };
}

async function saveTeam(teamId: string, patch: Partial<Pick<TeamRow, 'tokens' | 'free_roads' | 'hand' | 'tasks'>>): Promise<ActionResult> {
	const { error } = await db().from('vs_catan_teams').update(patch).eq('id', teamId);
	return error ? { ok: false, error: error.message } : { ok: true };
}

/** Trim a team's finished tasks to the newest TASK_HISTORY_CAP (active always kept). */
function trimTasks(tasks: TeamTask[]): TeamTask[] {
	const active = tasks.filter((t) => t.status === 'active');
	const done = tasks.filter((t) => t.status !== 'active').slice(-TASK_HISTORY_CAP);
	return [...done, ...active];
}

async function refreshHolders(ev: EventRow): Promise<ActionResult> {
	const rows = await loadRows(ev.slug);
	if (!rows) return { ok: false, error: 'Game vanished' };
	const snap = buildSnapshot(rows.ev, rows.teams, rows.pieces);
	const holders = updateHolders(snap);
	const prev = rows.ev.structure.catan.holders;
	if (holders.longestRoad === prev.longestRoad && holders.largestArmy === prev.largestArmy) return { ok: true };
	rows.ev.structure.catan.holders = holders;
	if (holders.longestRoad !== prev.longestRoad)
		return logAndSave(rows.ev, holders.longestRoad, 'longest_road', { from: prev.longestRoad, to: holders.longestRoad });
	return logAndSave(rows.ev, holders.largestArmy, 'largest_army', { from: prev.largestArmy, to: holders.largestArmy });
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
		snap: buildSnapshot(rows.ev, rows.teams, rows.pieces),
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
		const r = await saveTeam(teamId, { tokens: subtractCost(tokensOf(ctx.team), COSTS.settlement) });
		if (!r.ok) return r;
	}
	const rl = await logAndSave(ctx.ev, teamId, 'settlement', { vertex, free: verdict.free });
	if (!rl.ok) return rl;
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
		const r = await saveTeam(teamId, { free_roads: ctx.team.free_roads - 1 });
		if (!r.ok) return r;
	} else if (!setupFree) {
		const r = await saveTeam(teamId, { tokens: subtractCost(tokensOf(ctx.team), COSTS.road) });
		if (!r.ok) return r;
	}
	const rl = await logAndSave(ctx.ev, teamId, 'road', { edge, free: verdict.free });
	if (!rl.ok) return rl;
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
	const r = await saveTeam(teamId, { tokens: subtractCost(tokensOf(ctx.team), COSTS.city) });
	if (!r.ok) return r;
	return logAndSave(ctx.ev, teamId, 'city', { vertex });
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

	const entry: TeamTask = {
		id: crypto.randomUUID(),
		vertex,
		hex,
		task: { ...task, type: tile.type, rating: tile.rating },
		status: 'active',
		payout: null,
		rolled_at: new Date().toISOString(),
		completed_at: null
	};
	const r = await saveTeam(teamId, { tasks: trimTasks([...ctx.team.tasks, entry]) });
	if (!r.ok) return r;
	return logAndSave(ctx.ev, teamId, 'task_rolled', { vertex, hex, type: tile.type, rating: tile.rating, task: task.label });
}

export async function completeTask(slug: string, teamId: string, taskId: string): Promise<ActionResult> {
	const ctx = await withTeam(slug, teamId);
	if ('error' in ctx) return { ok: false, error: ctx.error };
	const task = ctx.team.tasks.find((t) => t.id === taskId);
	if (!task) return { ok: false, error: 'Task not found' };
	if (task.status !== 'active') return { ok: false, error: 'Task is not active' };

	// §3 same-type multiplier, computed at completion time against the current network.
	const type = task.task.type;
	const amount = Math.max(1, taskPayout(ctx.snap, teamId, type));
	task.status = 'completed';
	task.payout = { [type]: amount };
	task.completed_at = new Date().toISOString();

	const tokens = tokensOf(ctx.team);
	tokens[type] += amount;
	const r = await saveTeam(teamId, { tokens, tasks: trimTasks(ctx.team.tasks) });
	if (!r.ok) return r;
	return logAndSave(ctx.ev, teamId, 'task_completed', { taskId, type, amount });
}

export async function abandonTask(slug: string, teamId: string, taskId: string): Promise<ActionResult> {
	const ctx = await withTeam(slug, teamId);
	if ('error' in ctx) return { ok: false, error: ctx.error };
	const task = ctx.team.tasks.find((t) => t.id === taskId);
	if (!task || task.status !== 'active') return { ok: false, error: 'Task is not active' };
	task.status = 'abandoned';
	const r = await saveTeam(teamId, { tasks: trimTasks(ctx.team.tasks) });
	if (!r.ok) return r;
	return logAndSave(ctx.ev, teamId, 'task_abandoned', { taskId });
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
	const r = await saveTeam(teamId, { tokens });
	if (!r.ok) return r;
	return logAndSave(ctx.ev, teamId, 'grant', { ...grant });
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
	const r = await saveTeam(teamId, { tokens });
	if (!r.ok) return r;
	return logAndSave(ctx.ev, teamId, 'gold_exchange', { get, count, gold: cost });
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
	const r = await saveTeam(teamId, { tokens });
	if (!r.ok) return r;
	return logAndSave(ctx.ev, teamId, 'bank_trade', { give, get, count, rate });
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

	const drawn: HandCard = {
		id: crypto.randomUUID(),
		card,
		drawn_at: new Date().toISOString(),
		played_at: null,
		meta: {}
	};
	const r = await saveTeam(teamId, {
		hand: [...ctx.team.hand, drawn],
		tokens: subtractCost(tokens, COSTS.dev)
	});
	if (!r.ok) return r;
	// The drawn card is logged without naming it — hidden information stays hidden in the
	// log; the tester sees each team's hand in that team's own panel.
	return logAndSave(ctx.ev, teamId, 'dev_drawn', { remaining: cat.deck.length });
}

export async function playDevCard(
	slug: string,
	teamId: string,
	cardId: string,
	params: { vertex?: string; tokenType?: TileType; take?: TileType[] }
): Promise<ActionResult> {
	const ctx = await withTeam(slug, teamId);
	if ('error' in ctx) return { ok: false, error: ctx.error };
	const card = ctx.team.hand.find((c) => c.id === cardId);
	if (!card) return { ok: false, error: 'Card not found' };
	if (card.played_at) return { ok: false, error: 'Card already played' };

	const meta: Record<string, unknown> = {};
	const cat = ctx.ev.structure.catan;
	const patch: Parameters<typeof saveTeam>[1] = {};

	switch (card.card) {
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
				const r = await saveTeam(other.id, { tokens: theirs });
				if (!r.ok) return r;
			}
			const mine = tokensOf(ctx.team);
			mine[type] += collected;
			patch.tokens = mine;
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
			patch.tokens = mine;
			meta.take = take;
			break;
		}

		case 'shortcut': {
			// Road Building: the next 2 roads are free (§9).
			patch.free_roads = ctx.team.free_roads + 2;
			break;
		}
	}

	card.played_at = new Date().toISOString();
	card.meta = meta;
	patch.hand = ctx.team.hand;
	const r = await saveTeam(teamId, patch);
	if (!r.ok) return r;
	const rl = await logAndSave(ctx.ev, teamId, 'dev_played', { card: card.card, ...meta });
	if (!rl.ok) return rl;
	if (card.card === 'pker') return refreshHolders(ctx.ev); // army race
	return { ok: true };
}
