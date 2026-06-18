import { redirect, fail, error } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { isAdmin } from '$lib/server/auth';
import { isClanMember } from '$lib/server/clan';
import { renderMarkdown } from '$lib/markdown';
import { duoNodeRefs, DUO_SECTIONS, parseDuoNodeId } from '$lib/board/config';
import { getBoardStatus, type BoardStatus } from '$lib/board/state';
import {
	computeProgress,
	laneCountForFloor,
	type ProgressResult,
	type NodeState,
	type NodeProgress
} from '$lib/board/progress';
import { loadDuoStandings, type LeaderEntry, type ClanGroup } from '$lib/server/duoStandings';
import {
	DUO_WOLF_EVENT_SLUG,
	DUO_TILE_IDS,
	getDuoTileName,
	getDuoTileFaq,
	getDuoTileImg,
	getDuoTileRequired,
	getDuoTileAutoClear
} from '$lib/server/duoWolfTiles';
import { createSubmission } from '$lib/server/submissions';
import { BINGO_BUCKET } from '$lib/bingo/config';
import type { Actions, PageServerLoad } from './$types';

type SubmissionStatus = 'pending' | 'approved' | 'rejected';

// DuoWolf submissions live in the generic, dual-purpose vs_submissions table
// (team_id + target_id = the board node id), NOT the legacy vs_team_completions —
// so they flow through the same createSubmission/loadPendingReview/decideSubmissions
// pipeline as every other event and surface in /admin/submissions automatically.
interface CompletionRow {
	id: string;
	team_id: string;
	user_id: string;
	target_id: string;
	quantity: number | null;
	proof_urls: string[] | null;
	proof_paths: string[] | null;
	submitted_at: string;
	status: SubmissionStatus;
	review_note: string | null;
	vs_users: {
		rsn: string | null;
		discord_username: string;
		account_type: string | null;
	};
	reviewer: {
		rsn: string | null;
		discord_username: string;
	} | null;
	team: {
		id: string;
		name: string | null;
	} | null;
}

interface DuoCompletionDetail {
	id: string;
	user_id: string;
	rsn: string | null;
	discord_username: string;
	account_type: string | null;
	team_name: string | null;
	submitted_at: string;
	proof_urls: string[];
	quantity: number;
	reviewed_by_name: string | null;
	isMine: boolean;
}

interface DuoTeamSubmission {
	id: string;
	proof_urls: string[];
	quantity: number;
	submitted_at: string;
	status: SubmissionStatus;
	reviewed_by_name: string | null;
	review_note: string | null;
	submitted_by_name: string;
}

interface TileContent {
	name: string;
	img: string | null;
	faq_html: string | null;
	autoClear: string | null; // boss-only instant-clear label (null otherwise)
}


// Convert single newlines in the (markdown-able) FAQ into hard breaks, leaving
// blank-line paragraph breaks intact. renderMarkdown runs with breaks:false.
function faqToHtml(faq: string | null): string | null {
	if (!faq) return null;
	return renderMarkdown(faq.replace(/(?<!\n)\n(?!\n)/g, '  \n'));
}

function tileContent(id: string): TileContent {
	return {
		name: getDuoTileName(id) ?? id,
		img: getDuoTileImg(id),
		faq_html: faqToHtml(getDuoTileFaq(id)),
		autoClear: getDuoTileAutoClear(id)
	};
}

async function fetchEvent(slug: string) {
	const { data, error: qErr } = await db()
		.from('vs_events')
		.select('id, slug, name, status, starts_at')
		.eq('slug', slug)
		.maybeSingle();
	if (qErr) throw error(500, qErr.message);
	return data;
}

// The DuoWolf climb is LIVE for players once the event is open AND its start time has
// arrived. Before that (signups / pre-live) the board is sealed for non-admins — they see
// the empty skeleton only. Admins always preview. (Needs `starts_at` set on the event.)
function isClimbLive(event: { status: string | null; starts_at: string | null }): boolean {
	return (
		event.status === 'open' &&
		event.starts_at != null &&
		Date.now() >= new Date(event.starts_at).getTime()
	);
}

async function getMyTeamId(eventId: string, userId: string): Promise<string | null> {
	const { data } = await db()
		.from('vs_event_signups')
		.select('team_id')
		.eq('event_id', eventId)
		.eq('user_id', userId)
		.maybeSingle();
	return data?.team_id ?? null;
}

// Each team gets this many swaps per floor; they reset on the next floor (no carry-over).
const SWAPS_PER_FLOOR = 2;

// A team's swap position map (`${floor}:${section}:${step}` -> swapped-in lane), used by
// the progress engine so swapped tiles count + reveal correctly.
async function fetchSwapMap(eventId: string, teamId: string): Promise<Record<string, number>> {
	const map: Record<string, number> = {};
	const { data } = await db()
		.from('vs_team_tile_swaps')
		.select('floor, section, step, lane')
		.eq('event_id', eventId)
		.eq('team_id', teamId);
	for (const s of (data ?? []) as { floor: number; section: string; step: number; lane: number }[]) {
		map[`${s.floor}:${s.section}:${s.step}`] = s.lane;
	}
	return map;
}

interface SwapBalance {
	available: number;
	baseRemaining: number; // of this floor's SWAPS_PER_FLOOR
	bonusRemaining: number; // admin-granted, persist across floors
	perFloor: number;
}

// Base swaps reset each floor (SWAPS_PER_FLOOR - used this floor); bonus (admin-granted)
// swaps persist and are only consumed once a floor's base swaps are exhausted.
async function fetchSwapBalance(
	eventId: string,
	teamId: string,
	currentFloor: number | null
): Promise<SwapBalance> {
	const [{ data: swaps }, { data: grants }] = await Promise.all([
		db().from('vs_team_tile_swaps').select('floor').eq('event_id', eventId).eq('team_id', teamId),
		db().from('vs_team_swap_grants').select('amount').eq('event_id', eventId).eq('team_id', teamId)
	]);
	const usedByFloor: Record<number, number> = {};
	for (const s of (swaps ?? []) as { floor: number }[]) usedByFloor[s.floor] = (usedByFloor[s.floor] ?? 0) + 1;
	const bonusGranted = ((grants ?? []) as { amount: number }[]).reduce((a, g) => a + (Number(g.amount) || 0), 0);
	let bonusUsed = 0;
	for (const f of Object.keys(usedByFloor)) bonusUsed += Math.max(0, usedByFloor[Number(f)] - SWAPS_PER_FLOOR);
	const bonusRemaining = Math.max(0, bonusGranted - bonusUsed);
	const baseRemaining = currentFloor ? Math.max(0, SWAPS_PER_FLOOR - (usedByFloor[currentFloor] ?? 0)) : 0;
	return { available: baseRemaining + bonusRemaining, baseRemaining, bonusRemaining, perFloor: SWAPS_PER_FLOOR };
}

// Per-team progression (counts + path choices → stage machine). Shared by the
// load and the submit/choosePath actions so reveal + gating never drift.
async function fetchTeamProgress(eventId: string, teamId: string): Promise<ProgressResult> {
	const approvedByTile: Record<string, number> = {};
	const pendingByTile: Record<string, number> = {};
	const { data: rows } = await db()
		.from('vs_submissions')
		.select('target_id, status, quantity')
		.eq('event_id', eventId)
		.eq('team_id', teamId);
	// Sum each submission's quantity (default 1) — not a raw row count — so one proof can
	// cover several of a count-based tile's required total.
	for (const r of (rows ?? []) as { target_id: string; status: SubmissionStatus; quantity: number | null }[]) {
		const q = Math.max(1, Number(r.quantity) || 1);
		if (r.status === 'approved') approvedByTile[r.target_id] = (approvedByTile[r.target_id] ?? 0) + q;
		else if (r.status === 'pending') pendingByTile[r.target_id] = (pendingByTile[r.target_id] ?? 0) + q;
	}

	const choiceByFloorSection: Record<string, number> = {};
	const { data: choices } = await db()
		.from('vs_team_path_choices')
		.select('floor, section, lane')
		.eq('event_id', eventId)
		.eq('team_id', teamId);
	for (const ch of (choices ?? []) as { floor: number; section: string; lane: number }[]) {
		choiceByFloorSection[`${ch.floor}:${ch.section}`] = ch.lane;
	}

	const requiredByTile: Record<string, number> = {};
	for (const ref of duoNodeRefs()) requiredByTile[ref.id] = getDuoTileRequired(ref.id);

	const swapByPositionKey = await fetchSwapMap(eventId, teamId);

	return computeProgress({
		approvedByTile,
		pendingByTile,
		requiredByTile,
		choiceByFloorSection,
		swapByPositionKey
	});
}

export const load: PageServerLoad = async ({ params, locals, url }) => {
	if (!locals.user) throw redirect(303, '/');
	if (!locals.user.rsn || !locals.user.clan_allegiance || !locals.user.account_type) {
		throw redirect(303, '/onboarding');
	}

	const event = await fetchEvent(params.slug);
	if (!event) throw error(404, 'Event not found');

	const admin = isAdmin(locals.user);
	// Admins can preview the live PLAYER view (fog of war, per-team reveal) via
	// ?view=player to test what teams actually see. `effectiveAdmin` drives the board
	// payload (full board vs player reveal); the real `admin` still gates the toggle and
	// the admin-only actions.
	const previewAsPlayer = admin && url.searchParams.get('view') === 'player';
	const effectiveAdmin = admin && !previewAsPlayer;
	const isDuoWolf = event.slug === DUO_WOLF_EVENT_SLUG;
	const live = isClimbLive(event);
	// GENUINE non-admins only see the board once the climb is LIVE; before that it's sealed
	// (empty skeleton, no content, no leaderboard). ANY admin sees it anytime — including
	// "preview as player" (admin but effectiveAdmin=false), which still gets the player
	// fog-of-war reveal but isn't blocked pre-live, since it's a testing tool.
	let status: BoardStatus;
	if (admin) status = getBoardStatus(event.status, true);
	else if (event.status === 'closed' || event.status === 'locked') status = 'past-locked';
	else status = live ? 'open' : 'blurred';
	const contentVisible = isDuoWolf && (effectiveAdmin || status === 'open');

	const content: Record<string, TileContent> = {};
	let completionsForClient: Record<string, DuoCompletionDetail[]> = {};
	let completionCountForClient: Record<string, number> = {};
	const teamSubmissionsByTile: Record<string, DuoTeamSubmission[]> = {};
	let nodeState: Record<string, NodeState> = {};
	let nodeProgress: Record<string, NodeProgress> = {};
	let chosenLaneByFloorSection: Record<string, number | null> = {};
	let currentStageIndex = -1;
	let memberOfClan = false;
	let myTeamId: string | null = null;
	// SWAPS (player/preview only): how many the team can still use + the positions already
	// swapped, so the board can show the balance + which tiles came from another path.
	let swapsAvailable = 0;
	let swapsBase = 0;
	let swapsBonus = 0;
	let mySwaps: { floor: number; section: string; step: number; lane: number }[] = [];
	// Leaderboard (top 20, spoiler-free) + clan groups + on-board markers (top 10 → nodeId → names).
	let leaderboard: LeaderEntry[] = [];
	let byClan: ClanGroup[] = [];
	let teamMarkers: Record<string, { rank: number; name: string }[]> = {};
	let teamCount = 0;

	if (contentVisible) {
		memberOfClan = await isClanMember(locals.user.discord_id, locals.user.rsn);
		myTeamId = await getMyTeamId(event.id, locals.user.id);

		const { data: completionsRaw, error: cErr } = await db()
			.from('vs_submissions')
			.select(
				'id, team_id, user_id, target_id, quantity, proof_urls, proof_paths, submitted_at, status, review_note, vs_users!user_id(rsn, discord_username, account_type), reviewer:vs_users!reviewed_by(rsn, discord_username), team:vs_teams!team_id(id, name)'
			)
			.eq('event_id', event.id)
			.order('submitted_at', { ascending: true });
		// Degrade gracefully if the tables aren't there yet (migrations applied by
		// hand): admins can still preview tile content; submissions show empty.
		if (cErr) console.warn('[duo board] could not load completions:', cErr.message);

		const completions = (completionsRaw ?? []) as unknown as CompletionRow[];

		const completionsByTile: Record<string, DuoCompletionDetail[]> = {};
		const completionCountByTile: Record<string, number> = {};
		const myApproved: Record<string, number> = {};
		const myPending: Record<string, number> = {};
		const myRejected: Record<string, number> = {};

		for (const c of completions) {
			if (!DUO_TILE_IDS.has(c.target_id)) continue;
			const proofUrls = c.proof_urls ?? [];
			const qty = Math.max(1, Number(c.quantity) || 1);
			const reviewerName = c.reviewer ? (c.reviewer.rsn ?? c.reviewer.discord_username) : null;
			const submitterName = c.vs_users.rsn ?? c.vs_users.discord_username;
			const mine = myTeamId != null && c.team_id === myTeamId;

			if (c.status === 'approved') {
				const arr = completionsByTile[c.target_id] ?? [];
				arr.push({
					id: c.id,
					user_id: c.user_id,
					rsn: c.vs_users.rsn,
					discord_username: c.vs_users.discord_username,
					account_type: c.vs_users.account_type,
					team_name: c.team?.name ?? null,
					submitted_at: c.submitted_at,
					proof_urls: proofUrls,
					quantity: qty,
					reviewed_by_name: reviewerName,
					isMine: mine
				});
				completionsByTile[c.target_id] = arr;
				completionCountByTile[c.target_id] = (completionCountByTile[c.target_id] ?? 0) + 1;
				// Progress sums approved quantity (not row count) so one proof can cover many.
				if (mine) myApproved[c.target_id] = (myApproved[c.target_id] ?? 0) + qty;
			} else if (c.status === 'pending' && mine) {
				myPending[c.target_id] = (myPending[c.target_id] ?? 0) + qty;
			} else if (c.status === 'rejected' && mine) {
				myRejected[c.target_id] = (myRejected[c.target_id] ?? 0) + 1;
			}

			if (mine) {
				const t = teamSubmissionsByTile[c.target_id] ?? [];
				t.push({
					id: c.id,
					proof_urls: proofUrls,
					quantity: qty,
					submitted_at: c.submitted_at,
					status: c.status,
					reviewed_by_name: reviewerName,
					review_note: c.review_note ?? null,
					submitted_by_name: submitterName
				});
				teamSubmissionsByTile[c.target_id] = t;
			}
		}

		const choiceByFloorSection: Record<string, number> = {};
		if (myTeamId) {
			const { data: choices } = await db()
				.from('vs_team_path_choices')
				.select('floor, section, lane')
				.eq('event_id', event.id)
				.eq('team_id', myTeamId);
			for (const ch of (choices ?? []) as { floor: number; section: string; lane: number }[]) {
				choiceByFloorSection[`${ch.floor}:${ch.section}`] = ch.lane;
			}
		}

		const requiredByTile: Record<string, number> = {};
		for (const ref of duoNodeRefs()) requiredByTile[ref.id] = getDuoTileRequired(ref.id);

		const swapByPositionKey = myTeamId ? await fetchSwapMap(event.id, myTeamId) : {};

		const prog = computeProgress({
			approvedByTile: myApproved,
			pendingByTile: myPending,
			requiredByTile,
			choiceByFloorSection,
			swapByPositionKey,
			rejectedByTile: myRejected
		});

		if (effectiveAdmin) {
			// Admins get the full board (preview) — no per-team gating styling.
			// They review per team via /admin/duo/[slug]/review.
			for (const ref of duoNodeRefs()) content[ref.id] = tileContent(ref.id);
			completionsForClient = completionsByTile;
			completionCountForClient = completionCountByTile;
		} else {
			// Players: ONLY revealed nodes get content (anti-leak), plus their state.
			for (const id of prog.revealedNodeIds) content[id] = tileContent(id);
			nodeState = prog.nodeState;
			nodeProgress = prog.nodeProgress;
			chosenLaneByFloorSection = prog.chosenLaneByFloorSection;
			currentStageIndex = prog.currentStageIndex;
			// Per-team proof detail is admin-only; community counts limited to revealed tiles.
			for (const id of prog.revealedNodeIds) {
				if (completionCountByTile[id]) completionCountForClient[id] = completionCountByTile[id];
			}

			// Swap balance for this team (base resets per floor; bonus persists).
			if (myTeamId) {
				const stage = prog.stages[prog.currentStageIndex];
				const bal = await fetchSwapBalance(event.id, myTeamId, stage?.floor ?? null);
				swapsAvailable = bal.available;
				swapsBase = bal.baseRemaining;
				swapsBonus = bal.bonusRemaining;
				mySwaps = Object.entries(swapByPositionKey).map(([k, lane]) => {
					const [floor, section, step] = k.split(':');
					return { floor: Number(floor), section, step: Number(step), lane };
				});
			}
		}

		// Leaderboard (top 20, spoiler-free) + on-board markers (top 10) — shared with the
		// duo event page's "board is live" panel. See src/lib/server/duoStandings.ts.
		const standings = await loadDuoStandings(event.id, myTeamId, { topN: 20, markersTopN: 10 });
		leaderboard = standings.leaderboard;
		byClan = standings.byClan;
		teamMarkers = standings.teamMarkers;
		teamCount = standings.teamCount;
	}

	return {
		event: { id: event.id, slug: event.slug, name: event.name, status: event.status },
		status,
		// adminView = the full-board admin payload is being shown; previewAsPlayer = an
		// admin is currently viewing the player (fog-of-war) version; canToggleView = the
		// real user is an admin (show the view toggle).
		adminView: effectiveAdmin,
		previewAsPlayer,
		canToggleView: admin,
		isClanMember: memberOfClan,
		myTeamId,
		hasTeam: myTeamId != null,
		content,
		completionsByTile: completionsForClient,
		completionCountByTile: completionCountForClient,
		teamSubmissionsByTile,
		nodeState,
		nodeProgress,
		chosenLaneByFloorSection,
		currentStageIndex,
		swapsAvailable,
		swapsBase,
		swapsBonus,
		swapsPerFloor: SWAPS_PER_FLOOR,
		swaps: mySwaps,
		leaderboard,
		byClan,
		teamMarkers,
		teamCount
	};
};

function requireDuoWolf(slug: string): void {
	if (slug !== DUO_WOLF_EVENT_SLUG) throw error(404, 'Not found');
}

export const actions: Actions = {
	choosePath: async ({ params, locals, request }) => {
		if (!locals.user) throw redirect(303, '/');
		requireDuoWolf(params.slug);

		if (!(await isClanMember(locals.user.discord_id, locals.user.rsn))) {
			return fail(403, { error: 'Only Volition clan members can play this event.' });
		}

		const event = await fetchEvent(params.slug);
		if (!event) return fail(404, { error: 'Event not found' });
		const admin = isAdmin(locals.user);
		const isActive = admin ? event.status === 'open' || event.status === 'preview' : isClimbLive(event);
		if (!isActive) return fail(400, { error: 'The event is not open' });

		const teamId = await getMyTeamId(event.id, locals.user.id);
		if (!teamId) return fail(400, { error: 'Join the event and pair up with a teammate first.' });

		const form = await request.formData();
		const floor = Number(form.get('floor'));
		const section = form.get('section')?.toString() ?? '';
		const lane = Number(form.get('lane'));
		if (!Number.isInteger(floor) || !(DUO_SECTIONS as readonly string[]).includes(section)) {
			return fail(400, { error: 'Invalid path' });
		}
		if (!Number.isInteger(lane) || lane < 0 || lane >= laneCountForFloor(floor)) {
			return fail(400, { error: 'Invalid path' });
		}

		// Must be the team's CURRENT section stage.
		const prog = await fetchTeamProgress(event.id, teamId);
		const current = prog.stages[prog.currentStageIndex];
		if (!current || current.kind !== 'section' || current.floor !== floor || current.section !== section) {
			return fail(400, { error: "That path choice isn't available right now." });
		}

		const { error: insErr } = await db().from('vs_team_path_choices').insert({
			event_id: event.id,
			team_id: teamId,
			floor,
			section,
			lane,
			chosen_by: locals.user.id
		});
		if (insErr) {
			if (insErr.message.includes('duplicate') || insErr.message.includes('unique')) {
				return fail(409, { error: 'Your team already chose a path for this section.' });
			}
			return fail(500, { error: insErr.message });
		}

		return { ok: true, action: 'choosePath' as const, floor, section, lane };
	},

	// Use a SWAP: replace an active path tile with the same-position tile from an adjacent
	// path. Costs one swap (2/floor + bonus). Server-authoritative — never trusts the client.
	swapTile: async ({ params, locals, request }) => {
		if (!locals.user) throw redirect(303, '/');
		requireDuoWolf(params.slug);

		if (!(await isClanMember(locals.user.discord_id, locals.user.rsn))) {
			return fail(403, { error: 'Only Volition clan members can play this event.' });
		}

		const event = await fetchEvent(params.slug);
		if (!event) return fail(404, { error: 'Event not found' });
		const admin = isAdmin(locals.user);
		const isActive = admin ? event.status === 'open' || event.status === 'preview' : isClimbLive(event);
		if (!isActive) return fail(400, { error: 'The event is not open' });

		const teamId = await getMyTeamId(event.id, locals.user.id);
		if (!teamId) return fail(400, { error: 'Join the event and pair up with a teammate first.' });

		const form = await request.formData();
		const tileId = form.get('tile_id')?.toString() ?? '';
		const toLane = Number(form.get('to_lane'));
		const ref = parseDuoNodeId(tileId);
		if (!ref || ref.kind !== 'path' || ref.section == null || ref.lane == null || ref.step == null) {
			return fail(400, { error: 'You can only swap path tiles.' });
		}
		if (!Number.isInteger(toLane) || toLane < 0 || toLane >= laneCountForFloor(ref.floor)) {
			return fail(400, { error: 'Invalid swap target.' });
		}
		// Any OTHER parallel path at this step (left/middle/right) — just not the tile's own.
		if (toLane === ref.lane) {
			return fail(400, { error: 'Pick a different path to swap to.' });
		}

		// Authoritative: the tile must be the team's CURRENT active tile and not yet started.
		const prog = await fetchTeamProgress(event.id, teamId);
		if (prog.nodeState[tileId] !== 'active') {
			return fail(400, { error: "That tile isn't your team's active tile right now." });
		}
		const p = prog.nodeProgress[tileId];
		if (p && p.approved + p.pending > 0) {
			return fail(400, { error: "You've already started this tile — swap before submitting any proof." });
		}

		// Must have a swap available for this floor (2/floor + admin bonus).
		const bal = await fetchSwapBalance(event.id, teamId, ref.floor);
		if (bal.available <= 0) {
			return fail(400, { error: 'No swaps left — they reset after each floor boss.' });
		}

		const { error: insErr } = await db().from('vs_team_tile_swaps').insert({
			event_id: event.id,
			team_id: teamId,
			floor: ref.floor,
			section: ref.section,
			step: ref.step,
			lane: toLane,
			created_by: locals.user.id
		});
		if (insErr) {
			if (insErr.message.includes('duplicate') || insErr.message.includes('unique')) {
				return fail(409, { error: 'That tile has already been swapped.' });
			}
			return fail(500, { error: insErr.message });
		}

		return { ok: true, action: 'swapTile' as const, tile_id: tileId, to_lane: toLane };
	},

	submit: async ({ params, locals, request }) => {
		if (!locals.user) throw redirect(303, '/');
		requireDuoWolf(params.slug);

		if (!(await isClanMember(locals.user.discord_id, locals.user.rsn))) {
			return fail(403, { error: 'Only Volition clan members can submit tiles for this event.' });
		}

		const event = await fetchEvent(params.slug);
		if (!event) return fail(404, { error: 'Event not found' });
		const admin = isAdmin(locals.user);
		const isActive = admin ? event.status === 'open' || event.status === 'preview' : isClimbLive(event);
		if (!isActive) return fail(400, { error: 'Submissions are closed' });

		const teamId = await getMyTeamId(event.id, locals.user.id);
		if (!teamId) {
			return fail(400, { error: 'Join the event and pair up with a teammate before submitting.' });
		}

		const form = await request.formData();
		const tileId = form.get('tile_id')?.toString() ?? '';
		const files = form.getAll('proof').filter((f): f is File => f instanceof File && f.size > 0);

		if (!DUO_TILE_IDS.has(tileId)) return fail(400, { error: 'Unknown tile' });
		if (files.length === 0) return fail(400, { error: 'Add at least one proof image' });

		// How many of the tile's required total this one proof covers (e.g. one pic of all
		// 25 Wintertodt rewards). Clamp to 1..required so a single proof can't over-claim
		// past the whole tile; the admin still verifies the amount on approval.
		const required = getDuoTileRequired(tileId);
		const rawQty = Math.floor(Number(form.get('quantity') ?? 1));
		const quantity = Math.max(1, Math.min(Number.isFinite(rawQty) ? rawQty : 1, required));

		// Test submission: only an admin can flag it (the board's "preview as player" mode
		// posts test=1). Keeps test runs out of the live /admin/submissions queue.
		const isTest = isAdmin(locals.user) && form.get('test') === '1';

		// Authoritative gating: the tile must be in the team's current active step.
		const prog = await fetchTeamProgress(event.id, teamId);
		const state = prog.nodeState[tileId];
		if (state !== 'active') {
			return fail(400, { error: "That tile isn't open for your team yet." });
		}

		// One generic vs_submissions row (team_id + target_id = the board node), uploaded
		// + inserted by the shared framework — it then shows in /admin/submissions.
		const result = await createSubmission({
			eventId: event.id,
			userId: locals.user.id,
			teamId,
			targetId: tileId,
			targetLabel: getDuoTileName(tileId) ?? tileId,
			quantity,
			test: isTest,
			files
		});
		if (!result.ok) return fail(400, { error: result.error });

		return { ok: true, action: 'submit' as const, tile_id: tileId };
	},

	// TEST TOOL (admin-only): insta-complete the team's current active tile by inserting
	// an already-approved TEST submission covering whatever's left of its required total.
	// Lets an admin blast through the progression while testing; the rows are test-flagged
	// (hidden from the live queue, wiped by db/scripts/reset_duo_board.sql).
	testComplete: async ({ params, locals, request }) => {
		if (!locals.user) throw redirect(303, '/');
		requireDuoWolf(params.slug);
		if (!isAdmin(locals.user)) return fail(403, { error: 'Admins only (test tool).' });

		const event = await fetchEvent(params.slug);
		if (!event) return fail(404, { error: 'Event not found' });

		const teamId = await getMyTeamId(event.id, locals.user.id);
		if (!teamId) return fail(400, { error: 'Join the event and pair up with a teammate first.' });

		const form = await request.formData();
		const tileId = form.get('tile_id')?.toString() ?? '';
		if (!DUO_TILE_IDS.has(tileId)) return fail(400, { error: 'Unknown tile' });

		// Only the team's current active tile, so progression stays valid (choose a path
		// first for section tiles).
		const prog = await fetchTeamProgress(event.id, teamId);
		if (prog.nodeState[tileId] !== 'active') {
			return fail(400, { error: "That tile isn't active for your team right now." });
		}

		// Cover exactly what's left to finish the tile.
		const required = getDuoTileRequired(tileId);
		const approved = prog.nodeProgress[tileId]?.approved ?? 0;
		const remaining = Math.max(1, required - approved);

		const { error: insErr } = await db().from('vs_submissions').insert({
			event_id: event.id,
			team_id: teamId,
			user_id: locals.user.id,
			target_id: tileId,
			target_label: getDuoTileName(tileId) ?? tileId,
			quantity: remaining,
			test: true,
			status: 'approved',
			reviewed_by: locals.user.id,
			reviewed_at: new Date().toISOString(),
			review_note: 'Test insta-complete',
			proof_urls: [],
			proof_paths: []
		});
		if (insErr) return fail(500, { error: insErr.message });

		return { ok: true, action: 'testComplete' as const, tile_id: tileId };
	},

	remove: async ({ params, locals, request }) => {
		if (!locals.user) throw redirect(303, '/');
		requireDuoWolf(params.slug);

		if (!(await isClanMember(locals.user.discord_id, locals.user.rsn))) {
			return fail(403, { error: 'Only Volition clan members can manage submissions.' });
		}

		const event = await fetchEvent(params.slug);
		if (!event) return fail(404, { error: 'Event not found' });
		const admin = isAdmin(locals.user);
		const isActive = admin ? event.status === 'open' || event.status === 'preview' : isClimbLive(event);
		if (!isActive) return fail(400, { error: 'You can only remove submissions while the event is open' });

		const teamId = await getMyTeamId(event.id, locals.user.id);
		if (!teamId) return fail(400, { error: "You're not on a team for this event" });

		const form = await request.formData();
		const submissionId = form.get('submission_id')?.toString() ?? '';
		if (!submissionId) return fail(400, { error: 'Missing submission_id' });

		// Any teammate may remove their team's submission.
		const { data: existing } = await db()
			.from('vs_submissions')
			.select('id, proof_paths')
			.eq('id', submissionId)
			.eq('event_id', event.id)
			.eq('team_id', teamId)
			.maybeSingle();
		if (!existing) return fail(404, { error: 'Submission not found' });

		const { error: delErr } = await db()
			.from('vs_submissions')
			.delete()
			.eq('id', existing.id);
		if (delErr) return fail(500, { error: delErr.message });

		const paths = (existing.proof_paths ?? []) as string[];
		if (paths.length) {
			await db().storage.from(BINGO_BUCKET).remove(paths);
		}

		return { ok: true, action: 'remove' as const, submission_id: submissionId };
	},

	adminReject: async ({ params, locals, request }) => {
		if (!locals.user) throw redirect(303, '/');
		if (!isAdmin(locals.user)) return fail(403, { error: 'Not allowed' });
		requireDuoWolf(params.slug);

		const event = await fetchEvent(params.slug);
		if (!event) return fail(404, { error: 'Event not found' });

		const form = await request.formData();
		const submissionId = form.get('submission_id')?.toString() ?? '';
		const note = form.get('note')?.toString().trim() || null;
		if (!submissionId) return fail(400, { error: 'Missing submission_id' });

		const { error: upErr } = await db()
			.from('vs_submissions')
			.update({
				status: 'rejected',
				reviewed_at: new Date().toISOString(),
				reviewed_by: locals.user.id,
				review_note: note
			})
			.eq('id', submissionId)
			.eq('event_id', event.id);
		if (upErr) return fail(500, { error: upErr.message });

		return { ok: true, action: 'adminReject' as const, submission_id: submissionId };
	}
};
