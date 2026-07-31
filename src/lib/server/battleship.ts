// Battleship — server store and actions. Loads a game into a snapshot, validates every
// action through the pure rules in $lib/battleship/rules, and writes.
//
// See docs/BATTLESHIP.md. Two things here are load-bearing and easy to break:
//
//  1. REDACTION. The full snapshot contains both fleets. A player must never receive the
//     enemy's ship positions, so the page payload goes through `redactFor()` — the enemy
//     side is reduced to the craters already on its water plus the names of ships already
//     sunk. Never hand a raw snapshot to a member-facing endpoint.
//
//  2. CONCURRENCY. Everything that must not double-apply leans on a database constraint
//     rather than on read-then-write:
//       - spending a bomb is a CAS (`update … where spent_at is null` + row count check),
//       - firing writes one row per CELL with ON CONFLICT DO NOTHING, and the rows that
//         actually landed — not the pre-read — decide what this bomb hit.
//     Two players firing at once therefore split the cells instead of both "hitting".

import { db } from './db';
import { renderMarkdown } from '$lib/markdown';
import {
	autoPlace,
	bombCells,
	boardSizeFor,
	cellId,
	DEFAULT_TIERS,
	draftTurn,
	emptyFleet,
	fleetComplete,
	parseCell,
	resolveFire,
	sideStanding,
	tierForValue,
	validatePlacement,
	type BattleshipConfig,
	type CellId,
	type Phase,
	type Ship,
	type SideStanding,
	type Tier
} from '$lib/battleship/rules';

export const BATTLESHIP_KIND = 'battleship';

const SIDE_COLORS = ['#3b82f6', '#ef4444'];
const DEFAULT_PLACEMENT_MINUTES = 60;

// ── Row shapes ──────────────────────────────────────────────────────────────

export interface SideMember {
	userId: string;
	rsn: string | null;
	discordId: string | null;
}

export interface BattleshipSide {
	side: number;
	name: string;
	color: string;
	teamId: string | null;
	captainUserId: string | null;
	fleet: Ship[];
	placedAt: string | null;
	members: SideMember[];
}

export interface ShotRow {
	targetSide: number;
	cell: CellId;
	bombId: string;
	tier: number;
	hit: boolean;
	shipId: string | null;
	byUserId: string | null;
	firedAt: string;
}

export interface ArsenalRow {
	id: string;
	side: number;
	earnedBy: string | null;
	tier: number;
	value: number;
	itemName: string | null;
	source: string | null;
	earnedAt: string;
	spentAt: string | null;
}

export interface DraftPick {
	side: number;
	user_id: string;
	at: string;
}

export interface BattleshipSnapshot {
	event: {
		id: string;
		slug: string;
		name: string;
		description: string | null;
		/** Markdown-rendered `description`, so the page can show the full rules blurb. */
		descriptionHtml: string | null;
		status: string;
		signupOpensAt: string | null;
		signupClosesAt: string | null;
		startsAt: string | null;
		endsAt: string | null;
	};
	config: BattleshipConfig;
	phase: Phase;
	placementEndsAt: string | null;
	firstSide: 1 | 2;
	winner: number | null;
	test: boolean;
	sides: BattleshipSide[];
	shots: ShotRow[];
	arsenal: ArsenalRow[];
	/** Signed-up members not yet drafted onto a side. */
	pool: SideMember[];
	draft: { picks: DraftPick[]; turn: 1 | 2; complete: boolean };
	standings: SideStanding[];
}

type Result<T = undefined> = { ok: true; value?: T } | { ok: false; error: string };

const okResult = <T>(value?: T): Result<T> => ({ ok: true, value });
const errResult = (error: string): Result<never> => ({ ok: false, error });

// ── Structure helpers ───────────────────────────────────────────────────────

interface StructureBs {
	phase?: Phase;
	size?: number;
	tiers?: Tier[];
	placement_minutes?: number;
	placement_ends_at?: string | null;
	first_side?: 1 | 2;
	winner?: number | null;
	draft?: { picks?: DraftPick[] };
	test?: boolean;
}

function readStructure(structure: unknown): StructureBs {
	if (!structure || typeof structure !== 'object') return {};
	const bs = (structure as Record<string, unknown>).battleship;
	if (!bs || typeof bs !== 'object') return {};
	return bs as StructureBs;
}

/**
 * Merge a patch into `structure.battleship`, preserving every other structure key.
 * Read-modify-write on a jsonb column: fine for phase/draft bookkeeping (single-writer
 * admin actions and the serialized draft), never used for shots or arsenal.
 */
async function patchStructure(eventId: string, patch: Partial<StructureBs>): Promise<Result> {
	const sb = db();
	const { data, error } = await sb.from('vs_events').select('structure').eq('id', eventId).maybeSingle();
	if (error) return errResult(error.message);
	const structure = (data?.structure ?? {}) as Record<string, unknown>;
	const bs = { ...(readStructure(structure) as Record<string, unknown>), ...patch };
	const { error: uErr } = await sb
		.from('vs_events')
		.update({ structure: { ...structure, battleship: bs } })
		.eq('id', eventId);
	return uErr ? errResult(uErr.message) : okResult();
}

function configFrom(bs: StructureBs, perSide: number): BattleshipConfig {
	return {
		size: bs.size ?? boardSizeFor(perSide),
		tiers: bs.tiers?.length ? bs.tiers : DEFAULT_TIERS,
		placement_minutes: bs.placement_minutes ?? DEFAULT_PLACEMENT_MINUTES
	};
}

// ── Load ────────────────────────────────────────────────────────────────────

/**
 * Full snapshot — BOTH fleets. Server-only; run it through `redactFor` before it
 * reaches a member. Reads fail open (a missing table returns null) so a half-applied
 * schema shows an empty game instead of a 500.
 */
export async function loadBattleship(slug: string): Promise<BattleshipSnapshot | null> {
	const sb = db();
	const { data: ev } = await sb
		.from('vs_events')
		.select('id, slug, name, description, kind, status, structure, signup_opens_at, signup_closes_at, starts_at, ends_at')
		.eq('slug', slug)
		.maybeSingle();
	if (!ev || ev.kind !== BATTLESHIP_KIND) return null;

	const bs = readStructure(ev.structure);

	const [{ data: teamRows }, { data: signupRows }, { data: shotRows }, { data: arsenalRows }] =
		await Promise.all([
			sb.from('vs_battleship_teams').select('*').eq('event_id', ev.id).order('side'),
			sb.from('vs_event_signups').select('user_id, team_id').eq('event_id', ev.id),
			sb.from('vs_battleship_shots').select('*').eq('event_id', ev.id).order('fired_at'),
			sb.from('vs_battleship_arsenal').select('*').eq('event_id', ev.id).order('earned_at')
		]);

	const teams = (teamRows ?? []) as Record<string, never>[];
	const signups = (signupRows ?? []) as { user_id: string; team_id: string | null }[];

	// One roster read for everyone signed up, so members carry an RSN for display.
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

	const sides: BattleshipSide[] = teams.map((t) => {
		const row = t as unknown as {
			side: number;
			name: string;
			color: string;
			team_id: string | null;
			captain_user_id: string | null;
			fleet: Ship[];
			placed_at: string | null;
		};
		return {
			side: row.side,
			name: row.name,
			color: row.color,
			teamId: row.team_id,
			captainUserId: row.captain_user_id,
			fleet: Array.isArray(row.fleet) ? row.fleet : [],
			placedAt: row.placed_at,
			members: signups.filter((s) => s.team_id && s.team_id === row.team_id).map((s) => asMember(s.user_id))
		};
	});

	const pool = signups.filter((s) => !s.team_id).map((s) => asMember(s.user_id));

	const shots: ShotRow[] = ((shotRows ?? []) as Record<string, never>[]).map((r) => {
		const row = r as unknown as {
			target_side: number; cell: string; bomb_id: string; tier: number;
			hit: boolean; ship_id: string | null; by_user_id: string | null; fired_at: string;
		};
		return {
			targetSide: row.target_side, cell: row.cell, bombId: row.bomb_id, tier: row.tier,
			hit: row.hit, shipId: row.ship_id, byUserId: row.by_user_id, firedAt: row.fired_at
		};
	});

	const arsenal: ArsenalRow[] = ((arsenalRows ?? []) as Record<string, never>[]).map((r) => {
		const row = r as unknown as {
			id: string; side: number; earned_by: string | null; tier: number; value: number;
			item_name: string | null; source: string | null; earned_at: string; spent_at: string | null;
		};
		return {
			id: row.id, side: row.side, earnedBy: row.earned_by, tier: row.tier, value: Number(row.value) || 0,
			itemName: row.item_name, source: row.source, earnedAt: row.earned_at, spentAt: row.spent_at
		};
	});

	const perSide = Math.max(1, ...sides.map((s) => s.members.length), Math.ceil(signups.length / 2));
	const config = configFrom(bs, perSide);
	const picks = bs.draft?.picks ?? [];
	const firstSide = bs.first_side ?? 1;

	const snap: BattleshipSnapshot = {
		event: {
			id: ev.id, slug: ev.slug, name: ev.name, description: ev.description,
			descriptionHtml: renderMarkdown(ev.description), status: ev.status,
			signupOpensAt: ev.signup_opens_at, signupClosesAt: ev.signup_closes_at,
			startsAt: ev.starts_at, endsAt: ev.ends_at
		},
		config,
		phase: bs.phase ?? 'setup',
		placementEndsAt: bs.placement_ends_at ?? null,
		firstSide,
		winner: bs.winner ?? null,
		test: bs.test ?? false,
		sides,
		shots,
		arsenal,
		pool,
		draft: { picks, turn: draftTurn(picks.length, firstSide), complete: pool.length === 0 && picks.length > 0 },
		standings: []
	};
	snap.standings = computeStandings(snap);
	return snap;
}

export function computeStandings(snap: BattleshipSnapshot): SideStanding[] {
	return snap.sides.map((s) => {
		const incoming = new Set(snap.shots.filter((sh) => sh.targetSide === s.side).map((sh) => sh.cell));
		const outgoing = snap.shots
			.filter((sh) => sh.targetSide !== s.side)
			.map((sh) => ({ cell: sh.cell, hit: sh.hit }));
		// A ship counts as sunk by this side when every one of its cells has a crater on
		// the ENEMY board — the shots table is the only record, so this survives a reload.
		let sunkEnemyShips = 0;
		for (const enemy of snap.sides) {
			if (enemy.side === s.side) continue;
			const hitCells = new Set(snap.shots.filter((sh) => sh.targetSide === enemy.side).map((sh) => sh.cell));
			sunkEnemyShips += enemy.fleet.filter((f) => f.cells.length > 0 && f.cells.every((c) => hitCells.has(c))).length;
		}
		return sideStanding({
			side: s.side,
			name: s.name,
			ownFleet: s.fleet,
			incoming,
			outgoing,
			sunkEnemyShips,
			bombsUnspent: snap.arsenal.filter((a) => a.side === s.side && !a.spentAt).length
		});
	});
}

// ── Redaction ───────────────────────────────────────────────────────────────

export interface RedactedSide extends Omit<BattleshipSide, 'fleet'> {
	/** Present only for a side the viewer is allowed to see in full. */
	fleet: Ship[] | null;
	/** Always present: what the enemy has learned — ship sizes and whether each is sunk. */
	fleetSummary: { id: string; name: string; len: number; sunk: boolean }[];
	placed: boolean;
}

export interface BattleshipView extends Omit<BattleshipSnapshot, 'sides'> {
	sides: RedactedSide[];
	/** The viewer's side, or null for a spectator. */
	viewerSide: number | null;
	viewerUserId: string | null;
	viewerIsCaptain: boolean;
	viewerIsAdmin: boolean;
}

/**
 * Strip the enemy fleet. A viewer sees full ship positions only for their OWN side (and
 * an admin sees both — the tester needs it). For every other side the caller gets the
 * craters (already public via `shots`) and a per-ship sunk flag, which is exactly what a
 * real game reveals with "you sank my Battleship".
 */
export function redactFor(
	snap: BattleshipSnapshot,
	viewer: { userId: string | null; isAdmin: boolean }
): BattleshipView {
	const viewerSide =
		snap.sides.find((s) => s.members.some((m) => m.userId === viewer.userId))?.side ?? null;

	const sides: RedactedSide[] = snap.sides.map((s) => {
		const hitCells = new Set(snap.shots.filter((sh) => sh.targetSide === s.side).map((sh) => sh.cell));
		const canSeeFleet = viewer.isAdmin || (viewerSide !== null && s.side === viewerSide);
		return {
			side: s.side,
			name: s.name,
			color: s.color,
			teamId: s.teamId,
			captainUserId: s.captainUserId,
			members: s.members,
			placedAt: s.placedAt,
			placed: s.fleet.length > 0 && s.fleet.every((f) => f.cells.length > 0),
			fleet: canSeeFleet ? s.fleet : null,
			fleetSummary: s.fleet.map((f) => ({
				id: f.id,
				name: f.name,
				len: f.len,
				sunk: f.cells.length > 0 && f.cells.every((c) => hitCells.has(c))
			}))
		};
	});

	const side = snap.sides.find((s) => s.side === viewerSide);
	return {
		...snap,
		sides,
		viewerSide,
		viewerUserId: viewer.userId,
		viewerIsCaptain: !!side && side.captainUserId === viewer.userId,
		viewerIsAdmin: viewer.isAdmin
	};
}

// ── Lifecycle ───────────────────────────────────────────────────────────────

/** Create the event row. Starts in `signup`; the two sides are created by `startDraft`. */
export async function createBattleship(input: {
	slug: string;
	name: string;
	description?: string | null;
	signupOpensAt?: string | null;
	signupClosesAt?: string | null;
	ownerUserId: string;
	size?: number;
	tiers?: Tier[];
	placementMinutes?: number;
	test?: boolean;
	unlisted?: boolean;
}): Promise<Result<{ id: string; slug: string }>> {
	const sb = db();
	const battleship: StructureBs = {
		phase: 'signup',
		...(input.size ? { size: input.size } : {}),
		tiers: input.tiers?.length ? input.tiers : DEFAULT_TIERS,
		placement_minutes: input.placementMinutes ?? DEFAULT_PLACEMENT_MINUTES,
		first_side: 1,
		draft: { picks: [] },
		winner: null,
		test: input.test ?? false
	};
	const { data, error } = await sb
		.from('vs_events')
		.insert({
			slug: input.slug,
			name: input.name,
			description: input.description ?? null,
			kind: BATTLESHIP_KIND,
			// `open` so the event is visible and signups work; a test game is `unlisted`
			// instead of draft so the whole real flow (signup → draft → battle) is exercised.
			status: 'open',
			team_size: 1,
			unlisted: input.unlisted ?? input.test ?? false,
			signup_opens_at: input.signupOpensAt ?? null,
			signup_closes_at: input.signupClosesAt ?? null,
			structure: { battleship }
		})
		.select('id, slug')
		.single();
	if (error || !data) return errResult(error?.message ?? 'Could not create the event');
	return okResult({ id: data.id, slug: data.slug });
}

/**
 * Close signups and open the draft: create the two `vs_teams` + `vs_battleship_teams`
 * rows and seat each captain on their own side (a captain is a signed-up member, so
 * seating them is the same team_id write a draft pick makes).
 */
export async function startDraft(input: {
	eventId: string;
	captains: [string, string];
	names?: [string, string];
	firstSide?: 1 | 2;
}): Promise<Result> {
	const sb = db();
	const [c1, c2] = input.captains;
	if (!c1 || !c2) return errResult('Pick two captains');
	if (c1 === c2) return errResult('The captains must be two different members');

	const { data: existing } = await sb.from('vs_battleship_teams').select('id').eq('event_id', input.eventId).limit(1);
	if (existing && existing.length) return errResult('This game already has its sides');

	const { data: signups } = await sb
		.from('vs_event_signups')
		.select('user_id')
		.eq('event_id', input.eventId);
	const signedUp = new Set(((signups ?? []) as { user_id: string }[]).map((s) => s.user_id));
	if (!signedUp.has(c1) || !signedUp.has(c2)) return errResult('Both captains must be signed up');

	const names = input.names ?? ['Fleet Red', 'Fleet Blue'];
	for (let i = 0; i < 2; i++) {
		const captain = i === 0 ? c1 : c2;
		const { data: team, error: tErr } = await sb
			.from('vs_teams')
			.insert({ event_id: input.eventId, name: names[i], created_by: captain })
			.select('id')
			.single();
		if (tErr || !team) return errResult(tErr?.message ?? 'Could not create a team');

		const { error: btErr } = await sb.from('vs_battleship_teams').insert({
			event_id: input.eventId,
			team_id: team.id,
			side: i + 1,
			name: names[i],
			color: SIDE_COLORS[i],
			captain_user_id: captain,
			fleet: []
		});
		if (btErr) return errResult(btErr.message);

		const { error: sErr } = await sb
			.from('vs_event_signups')
			.update({ team_id: team.id })
			.eq('event_id', input.eventId)
			.eq('user_id', captain)
			.is('team_id', null);
		if (sErr) return errResult(sErr.message);
	}

	return patchStructure(input.eventId, {
		phase: 'draft',
		first_side: input.firstSide ?? 1,
		draft: { picks: [] }
	});
}

/**
 * Draft one member onto a side. The authoritative write is the CONDITIONAL update of
 * the signup row (`… where team_id is null`): if it matches nothing, someone else took
 * that member first and we stop before touching the draft log. So two captains clicking
 * the same player at the same time produce one pick, not two.
 */
export async function draftPick(input: {
	eventId: string;
	side: number;
	userId: string;
	/** Skip the turn check (admin override in the tester). */
	force?: boolean;
}): Promise<Result> {
	const snap = await loadBattleshipById(input.eventId);
	if (!snap) return errResult('Game not found');
	if (snap.phase !== 'draft') return errResult('The draft is not open');

	const side = snap.sides.find((s) => s.side === input.side);
	if (!side?.teamId) return errResult('Unknown side');
	if (!input.force && snap.draft.turn !== input.side) return errResult(`It is side ${snap.draft.turn}'s pick`);
	if (!snap.pool.some((p) => p.userId === input.userId)) return errResult('That member is not in the pool');

	const sb = db();
	const { data: claimed, error } = await sb
		.from('vs_event_signups')
		.update({ team_id: side.teamId })
		.eq('event_id', input.eventId)
		.eq('user_id', input.userId)
		.is('team_id', null)
		.select('id');
	if (error) return errResult(error.message);
	if (!claimed || claimed.length === 0) return errResult('That member was just drafted by the other side');

	const picks = [...snap.draft.picks, { side: input.side, user_id: input.userId, at: new Date().toISOString() }];
	const res = await patchStructure(input.eventId, { draft: { picks } });
	if (!res.ok) return res;

	// Last pick drains the pool — move straight into placement so nobody has to notice.
	if (snap.pool.length === 1) return openPlacement(input.eventId);
	return okResult();
}

/**
 * Draft the ENTIRE remaining pool in one go, alternating sides from wherever the draft
 * is now. Used by the tester's "auto-draft the rest" and by an admin closing out a draft
 * whose captains have gone quiet.
 *
 * Deliberately not a loop over draftPick(): that reloads the whole snapshot per pick
 * (~15 round trips each), so a 32-player pool took over a minute and blew past request
 * timeouts. This is one load, one conditional update per side, and one structure write.
 *
 * The CAS is kept — the update only claims rows still `team_id is null`, and only the
 * rows it actually claimed go into the draft log. If a captain picks concurrently the
 * sides can end up off by more than one; that's an accepted trade for a bulk admin tool.
 */
export async function autoDraftRemaining(eventId: string): Promise<Result<{ picked: number }>> {
	const snap = await loadBattleshipById(eventId);
	if (!snap) return errResult('Game not found');
	if (snap.phase !== 'draft') return errResult('The draft is not open');
	if (snap.pool.length === 0) return okResult({ picked: 0 });

	// Continue the alternation from the picks already made.
	const bySide = new Map<number, string[]>();
	const order: { side: number; user_id: string }[] = [];
	let picksMade = snap.draft.picks.length;
	for (const p of snap.pool) {
		const side = draftTurn(picksMade++, snap.firstSide);
		if (!bySide.has(side)) bySide.set(side, []);
		bySide.get(side)!.push(p.userId);
		order.push({ side, user_id: p.userId });
	}

	const sb = db();
	const claimed = new Set<string>();
	for (const [side, userIds] of bySide) {
		const teamId = snap.sides.find((s) => s.side === side)?.teamId;
		if (!teamId) return errResult(`Side ${side} has no team`);
		const { data, error } = await sb
			.from('vs_event_signups')
			.update({ team_id: teamId })
			.eq('event_id', eventId)
			.in('user_id', userIds)
			.is('team_id', null)
			.select('user_id');
		if (error) return errResult(error.message);
		for (const row of (data ?? []) as { user_id: string }[]) claimed.add(row.user_id);
	}

	const at = new Date().toISOString();
	const picks = [
		...snap.draft.picks,
		...order.filter((o) => claimed.has(o.user_id)).map((o) => ({ ...o, at }))
	];
	const res = await patchStructure(eventId, { draft: { picks } });
	if (!res.ok) return res;

	// Pool drained → straight into placement, same as the last manual pick would.
	if (claimed.size === snap.pool.length) {
		const opened = await openPlacement(eventId);
		if (!opened.ok) return opened;
	}
	return okResult({ picked: claimed.size });
}

/**
 * Drop out of the event.
 *
 * Only while the pool is still forming. Once the captains start drafting, the sides are
 * being balanced around exactly who is in the pool — pulling someone out mid-draft would
 * leave a side short with no way to refill it, and after placement it would leave a fleet
 * on the board with nobody behind it. Both cases need an admin, not a self-serve button.
 *
 * Deliberately allowed even after `signup_closes_at` has passed, as long as the draft
 * hasn't begun: someone who knows they can't make it is better out of the pool than
 * drafted and absent.
 */
export async function leaveEvent(input: { eventId: string; userId: string }): Promise<Result> {
	const snap = await loadBattleshipById(input.eventId);
	if (!snap) return errResult('Game not found');
	if (snap.phase !== 'signup') {
		return errResult('The draft has already started — ask an admin if you need to drop out');
	}

	// `is team_id null` is belt-and-braces behind the phase check: it makes it impossible
	// to delete a signup that has already been drafted onto a side, whatever the phase says.
	const { data, error } = await db()
		.from('vs_event_signups')
		.delete()
		.eq('event_id', input.eventId)
		.eq('user_id', input.userId)
		.is('team_id', null)
		.select('id');
	if (error) return errResult(error.message);
	if (!data || data.length === 0) return errResult("You're not signed up for this event");
	return okResult();
}

/** Open the 1-hour placement window. Sets the deadline the battle opens at. */
export async function openPlacement(eventId: string): Promise<Result> {
	const snap = await loadBattleshipById(eventId);
	if (!snap) return errResult('Game not found');
	const minutes = snap.config.placement_minutes;
	const endsAt = new Date(Date.now() + minutes * 60_000).toISOString();
	return patchStructure(eventId, { phase: 'placement', placement_ends_at: endsAt });
}

/** Store a side's fleet. Validated ship-by-ship; rejects a partial fleet. */
export async function placeFleet(input: {
	eventId: string;
	side: number;
	fleet: Ship[];
}): Promise<Result> {
	const snap = await loadBattleshipById(input.eventId);
	if (!snap) return errResult('Game not found');
	if (snap.phase !== 'placement') return errResult('Placement is closed');

	const size = snap.config.size;
	const expected = emptyFleet(size);
	if (input.fleet.length !== expected.length) return errResult('That is not the right number of ships');

	const byId = new Map(expected.map((s) => [s.id, s]));
	const placed: Ship[] = [];
	for (const ship of input.fleet) {
		const spec = byId.get(ship.id);
		if (!spec) return errResult(`Unknown ship ${ship.id}`);
		if (ship.len !== spec.len) return errResult(`${spec.name} must be ${spec.len} long`);
		const v = validatePlacement(ship, placed, size);
		if (v.ok !== true) return errResult(`${spec.name}: ${v.reason.replace(/_/g, ' ')}`);
		placed.push({ id: spec.id, name: spec.name, len: spec.len, cells: ship.cells });
	}
	if (!fleetComplete(placed, size)) return errResult('Every ship has to be on the board');

	const { error } = await db()
		.from('vs_battleship_teams')
		.update({ fleet: placed, placed_at: new Date().toISOString() })
		.eq('event_id', input.eventId)
		.eq('side', input.side);
	return error ? errResult(error.message) : okResult();
}

/**
 * Open the battle. Any side that never placed gets an auto-placed fleet — a side with no
 * ships cannot be shot at, which would stall the event for everyone else.
 */
export async function startBattle(eventId: string): Promise<Result> {
	const snap = await loadBattleshipById(eventId);
	if (!snap) return errResult('Game not found');
	if (snap.phase === 'battle') return okResult();
	if (snap.phase !== 'placement') return errResult('The draft has to finish first');

	const sb = db();
	for (const side of snap.sides) {
		if (side.fleet.length && side.fleet.every((f) => f.cells.length > 0)) continue;
		const { error } = await sb
			.from('vs_battleship_teams')
			.update({ fleet: autoPlace(snap.config.size), placed_at: new Date().toISOString() })
			.eq('event_id', eventId)
			.eq('side', side.side);
		if (error) return errResult(error.message);
	}

	const res = await patchStructure(eventId, { phase: 'battle' });
	if (!res.ok) return res;
	const { error } = await sb.from('vs_events').update({ starts_at: new Date().toISOString() }).eq('id', eventId);
	return error ? errResult(error.message) : okResult();
}

/**
 * Poll-on-read phase advance: once the placement deadline passes, the battle opens on
 * the next page load. Same "settle when someone looks" pattern as personal-board VP —
 * no scheduler to keep alive.
 */
export async function maybeAdvancePhase(snap: BattleshipSnapshot): Promise<boolean> {
	if (snap.phase !== 'placement' || !snap.placementEndsAt) return false;
	if (new Date(snap.placementEndsAt).getTime() > Date.now()) return false;
	const res = await startBattle(snap.event.id);
	return res.ok;
}

// ── Arsenal ─────────────────────────────────────────────────────────────────

/**
 * Turn a drop into a bomb. Idempotent at the DATABASE level via
 * unique (event_id, drop_key) — the Dink reconcile pass re-runs recent drops, so this
 * WILL be called twice for the same drop and must mint one bomb.
 *
 * Returns the tier when a bomb was minted, null when the drop was too small or already
 * banked.
 */
export async function earnBomb(input: {
	eventId: string;
	side: number;
	userId: string | null;
	value: number;
	dropKey: string;
	itemName?: string | null;
	source?: string | null;
	tiers?: Tier[];
}): Promise<{ minted: boolean; tier: number | null }> {
	const tier = tierForValue(input.value, input.tiers ?? DEFAULT_TIERS);
	if (!tier) return { minted: false, tier: null };

	const { data, error } = await db()
		.from('vs_battleship_arsenal')
		.upsert(
			{
				event_id: input.eventId,
				side: input.side,
				earned_by: input.userId,
				tier: tier.tier,
				value: Math.round(input.value),
				item_name: input.itemName ?? null,
				source: input.source ?? null,
				drop_key: input.dropKey
			},
			{ onConflict: 'event_id,drop_key', ignoreDuplicates: true }
		)
		.select('id');
	// ignoreDuplicates returns zero rows when the drop was already banked.
	if (error || !data || data.length === 0) return { minted: false, tier: tier.tier };
	return { minted: true, tier: tier.tier };
}

/**
 * The live battleship event a member is playing in, if any — the hook the Dink consumer
 * uses to decide whether a drop is worth a bomb. Null when they're not in one.
 */
export async function activeBattleshipFor(
	userId: string
): Promise<{ eventId: string; side: number; tiers: Tier[]; slug: string; name: string; startsAt: string | null } | null> {
	const sb = db();
	const { data: signups } = await sb.from('vs_event_signups').select('event_id, team_id').eq('user_id', userId);
	const rows = ((signups ?? []) as { event_id: string; team_id: string | null }[]).filter((s) => s.team_id);
	if (!rows.length) return null;

	const { data: events } = await sb
		.from('vs_events')
		.select('id, slug, name, structure, starts_at')
		.eq('kind', BATTLESHIP_KIND)
		.eq('status', 'open')
		.in('id', rows.map((r) => r.event_id));

	for (const ev of (events ?? []) as { id: string; slug: string; name: string; structure: unknown; starts_at: string | null }[]) {
		const bs = readStructure(ev.structure);
		if (bs.phase !== 'battle') continue;
		const teamId = rows.find((r) => r.event_id === ev.id)?.team_id;
		if (!teamId) continue;
		const { data: side } = await sb
			.from('vs_battleship_teams')
			.select('side')
			.eq('event_id', ev.id)
			.eq('team_id', teamId)
			.maybeSingle();
		if (!side) continue;
		return {
			eventId: ev.id,
			side: (side as { side: number }).side,
			tiers: bs.tiers?.length ? bs.tiers : DEFAULT_TIERS,
			slug: ev.slug,
			name: ev.name,
			startsAt: ev.starts_at
		};
	}
	return null;
}

// ── Firing ──────────────────────────────────────────────────────────────────

export interface FireReport {
	bombId: string;
	tier: number;
	cells: { cell: CellId; hit: boolean; shipId: string | null }[];
	skipped: CellId[];
	hits: number;
	sunk: { id: string; name: string }[];
	defeated: boolean;
}

/**
 * Fire one banked bomb at an anchor on the enemy board.
 *
 * Order matters: the bomb is CAS-claimed before any shot is written, so a double-submit
 * can't fire it twice; then the cells go in with ON CONFLICT DO NOTHING and only the rows
 * that actually landed count as this bomb's craters.
 */
export async function fireBomb(input: {
	eventId: string;
	arsenalId: string;
	byUserId: string | null;
	anchor: { x: number; y: number };
	/** Bypass the "must be yours / you must be captain" check (admin tester). */
	force?: boolean;
}): Promise<Result<FireReport>> {
	const snap = await loadBattleshipById(input.eventId);
	if (!snap) return errResult('Game not found');
	if (snap.phase !== 'battle') return errResult('The battle is not running');
	if (snap.winner) return errResult('This game is already over');

	const bomb = snap.arsenal.find((a) => a.id === input.arsenalId);
	if (!bomb) return errResult('Unknown bomb');
	if (bomb.spentAt) return errResult('That bomb has already been fired');

	const shooter = snap.sides.find((s) => s.side === bomb.side);
	const target = snap.sides.find((s) => s.side !== bomb.side);
	if (!shooter || !target) return errResult('This game does not have two sides');

	// Anyone on the side can fire a bomb they earned; a captain can fire any of their
	// side's bombs so nothing goes stale when the earner logs off.
	if (!input.force) {
		const onSide = shooter.members.some((m) => m.userId === input.byUserId);
		const isCaptain = shooter.captainUserId === input.byUserId;
		const isEarner = bomb.earnedBy === input.byUserId;
		if (!onSide) return errResult('You are not on that side');
		if (!isEarner && !isCaptain) return errResult('Only the member who earned this bomb, or the captain, can fire it');
	}

	const tier = (snap.config.tiers.find((t) => t.tier === bomb.tier) ?? DEFAULT_TIERS[0]);
	const size = snap.config.size;
	const cells = bombCells(input.anchor, tier.span, size);
	if (!cells) return errResult(`A ${tier.span}x${tier.span} bomb has to land fully on the board`);

	const alreadyFired = new Set(snap.shots.filter((s) => s.targetSide === target.side).map((s) => s.cell));
	const fresh = cells.filter((c) => !alreadyFired.has(c));
	// Refuse rather than burn the bomb on water that is already cratered.
	if (fresh.length === 0) return errResult('Every cell there has already been fired at');

	const sb = db();
	const bombId = crypto.randomUUID();

	// CAS: claim the bomb. If it matches no row, another request already spent it.
	const { data: claimed, error: claimErr } = await sb
		.from('vs_battleship_arsenal')
		.update({ spent_at: new Date().toISOString(), bomb_id: bombId })
		.eq('id', input.arsenalId)
		.is('spent_at', null)
		.select('id');
	if (claimErr) return errResult(claimErr.message);
	if (!claimed || claimed.length === 0) return errResult('That bomb has already been fired');

	const shipByCell = new Map<CellId, Ship>();
	for (const s of target.fleet) for (const c of s.cells) shipByCell.set(c, s);

	const rows = fresh.map((cell) => ({
		event_id: input.eventId,
		target_side: target.side,
		cell,
		bomb_id: bombId,
		tier: bomb.tier,
		by_user_id: input.byUserId,
		hit: shipByCell.has(cell),
		ship_id: shipByCell.get(cell)?.id ?? null
	}));

	// ON CONFLICT DO NOTHING: a cell another bomb claimed in the meantime is skipped,
	// and `landed` is the truth about what this bomb actually did.
	const { data: landed, error: shotErr } = await sb
		.from('vs_battleship_shots')
		.upsert(rows, { onConflict: 'event_id,target_side,cell', ignoreDuplicates: true })
		.select('cell, hit, ship_id');
	if (shotErr) return errResult(shotErr.message);

	const landedRows = ((landed ?? []) as { cell: string; hit: boolean; ship_id: string | null }[]);
	const landedCells = new Set(landedRows.map((r) => r.cell));
	const skipped = cells.filter((c) => !landedCells.has(c));

	// Lost every cell to a bomb that landed between our read and our write: hand the bomb
	// back rather than burning it on nothing. The pre-flight check above catches the
	// ordinary case; this only fires on a genuine race.
	if (landedRows.length === 0) {
		await sb
			.from('vs_battleship_arsenal')
			.update({ spent_at: null, bomb_id: null })
			.eq('id', input.arsenalId)
			.eq('bomb_id', bombId);
		return errResult('Every cell there had just been fired at — your bomb is still banked');
	}

	// Re-read the target's craters so sink/defeat is judged on the real post-write state
	// (this bomb's rows plus anything that landed concurrently), not on the pre-read.
	const { data: afterRows } = await sb
		.from('vs_battleship_shots')
		.select('cell')
		.eq('event_id', input.eventId)
		.eq('target_side', target.side);
	const after = new Set(((afterRows ?? []) as { cell: string }[]).map((r) => r.cell));

	const outcome = resolveFire(target.fleet, alreadyFired, [...landedCells]);
	const sunkNow = target.fleet.filter(
		(s) => s.cells.length > 0 && s.cells.every((c) => after.has(c)) && !s.cells.every((c) => alreadyFired.has(c))
	);
	const defeated = target.fleet.length > 0 && target.fleet.every((s) => s.cells.length > 0 && s.cells.every((c) => after.has(c)));

	if (defeated) {
		await patchStructure(input.eventId, { phase: 'finished', winner: shooter.side });
		await sb.from('vs_events').update({ ends_at: new Date().toISOString() }).eq('id', input.eventId);
	}

	return okResult<FireReport>({
		bombId,
		tier: bomb.tier,
		cells: landedRows.map((r) => ({ cell: r.cell, hit: r.hit, shipId: r.ship_id })),
		skipped,
		hits: landedRows.filter((r) => r.hit).length,
		sunk: sunkNow.map((s) => ({ id: s.id, name: s.name })),
		defeated: defeated || outcome.defeated
	});
}

// ── Internals ───────────────────────────────────────────────────────────────

async function loadBattleshipById(eventId: string): Promise<BattleshipSnapshot | null> {
	const { data } = await db().from('vs_events').select('slug').eq('id', eventId).maybeSingle();
	if (!data) return null;
	return loadBattleship((data as { slug: string }).slug);
}

/** Admin escape hatch: hand a side a bomb without a drop (testing, make-goods). */
export async function grantBomb(input: {
	eventId: string;
	side: number;
	tier: number;
	userId?: string | null;
	note?: string;
}): Promise<Result> {
	const { error } = await db().from('vs_battleship_arsenal').insert({
		event_id: input.eventId,
		side: input.side,
		earned_by: input.userId ?? null,
		tier: input.tier,
		value: 0,
		item_name: input.note ?? 'Granted by an admin',
		source: 'admin',
		drop_key: `admin:${crypto.randomUUID()}`
	});
	return error ? errResult(error.message) : okResult();
}

export { cellId, parseCell };
