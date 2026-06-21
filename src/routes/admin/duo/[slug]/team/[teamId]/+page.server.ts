import { redirect, error, fail } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { isAdmin } from '$lib/server/auth';
import { renderMarkdown } from '$lib/markdown';
import { duoNodeRefs, DUO_PET_SWAP_TARGET } from '$lib/board/config';
import { computeProgress } from '$lib/board/progress';
import {
	DUO_WOLF_EVENT_SLUG,
	DUO_TILE_IDS,
	getDuoTileName,
	getDuoTileImg,
	getDuoTileFaq,
	getDuoTileRequired
} from '$lib/server/duoWolfTiles';
import { ensureDuoTilesFresh } from '$lib/server/duoTileStore';
import type { Actions, PageServerLoad } from './$types';

type SubmissionStatus = 'pending' | 'approved' | 'rejected';

const SWAPS_PER_FLOOR = 2;

// DuoWolf submissions are generic vs_submissions rows (team_id + target_id = board node).
interface SubRow {
	id: string;
	target_id: string;
	quantity: number | null;
	proof_urls: string[] | null;
	submitted_at: string;
	status: SubmissionStatus;
	submitter: { rsn: string | null; discord_username: string } | null;
	reviewer: { rsn: string | null; discord_username: string } | null;
}

function faqToHtml(faq: string | null): string | null {
	if (!faq) return null;
	return renderMarkdown(faq.replace(/(?<!\n)\n(?!\n)/g, '  \n'));
}

function stageLabel(stage: { floor: number; kind: string; section?: string } | undefined): string {
	if (!stage) return 'Finished';
	if (stage.kind === 'start') return `Floor ${stage.floor} · Start`;
	if (stage.kind === 'boss') return `Floor ${stage.floor} · Boss`;
	if (stage.kind === 'mid') return `Floor ${stage.floor} · Intermission ${stage.section}`;
	return `Floor ${stage.floor} · Section ${stage.section}`;
}

export const load: PageServerLoad = async ({ params, locals }) => {
	if (!locals.user) throw redirect(303, '/');
	if (!isAdmin(locals.user)) throw error(403, 'Not allowed');
	if (params.slug !== DUO_WOLF_EVENT_SLUG) throw error(404, 'Not found');

	const { data: event, error: evErr } = await db()
		.from('vs_events')
		.select('id, slug, name')
		.eq('slug', params.slug)
		.maybeSingle();
	if (evErr) throw error(500, evErr.message);
	if (!event) throw error(404, 'Event not found');

	await ensureDuoTilesFresh();

	const { data: team, error: tErr } = await db()
		.from('vs_teams')
		.select('id, name')
		.eq('id', params.teamId)
		.eq('event_id', event.id)
		.maybeSingle();
	if (tErr) throw error(500, tErr.message);
	if (!team) throw error(404, 'Team not found');

	const { data: memberRows } = await db()
		.from('vs_event_signups')
		.select('vs_users(rsn, discord_username, account_type)')
		.eq('event_id', event.id)
		.eq('team_id', team.id);
	const members = ((memberRows ?? []) as unknown as { vs_users: { rsn: string | null; discord_username: string; account_type: string | null } }[]).map(
		(m) => ({
			rsn: m.vs_users.rsn,
			discord_username: m.vs_users.discord_username,
			account_type: m.vs_users.account_type
		})
	);

	const { data: subsRaw, error: sErr } = await db()
		.from('vs_submissions')
		.select(
			'id, target_id, quantity, proof_urls, submitted_at, status, submitter:vs_users!user_id(rsn, discord_username), reviewer:vs_users!reviewed_by(rsn, discord_username)'
		)
		.eq('event_id', event.id)
		.eq('team_id', team.id)
		.order('submitted_at', { ascending: true });
	if (sErr) throw error(500, sErr.message);
	const subs = (subsRaw ?? []) as unknown as SubRow[];

	const { data: choices } = await db()
		.from('vs_team_path_choices')
		.select('floor, section, lane')
		.eq('event_id', event.id)
		.eq('team_id', team.id);
	const choiceByFloorSection: Record<string, number> = {};
	for (const ch of (choices ?? []) as { floor: number; section: string; lane: number }[]) {
		choiceByFloorSection[`${ch.floor}:${ch.section}`] = ch.lane;
	}

	// Swaps: substitutions (for accurate progress) + balance (2/floor base + admin bonus +
	// approved pet submissions, each worth +1 — same derivation as the player board).
	const [{ data: swapRows }, { data: grantRows }, { count: petCount }] = await Promise.all([
		db().from('vs_team_tile_swaps').select('floor, section, step, lane').eq('event_id', event.id).eq('team_id', team.id),
		db().from('vs_team_swap_grants').select('amount').eq('event_id', event.id).eq('team_id', team.id),
		db()
			.from('vs_submissions')
			.select('id', { count: 'exact', head: true })
			.eq('event_id', event.id)
			.eq('team_id', team.id)
			.eq('target_id', DUO_PET_SWAP_TARGET)
			.eq('status', 'approved')
	]);
	const swapByPositionKey: Record<string, number> = {};
	const swapsUsedByFloor: Record<number, number> = {};
	for (const s of (swapRows ?? []) as { floor: number; section: string; step: number; lane: number }[]) {
		swapByPositionKey[`${s.floor}:${s.section}:${s.step}`] = s.lane;
		swapsUsedByFloor[s.floor] = (swapsUsedByFloor[s.floor] ?? 0) + 1;
	}
	const bonusGranted =
		((grantRows ?? []) as { amount: number }[]).reduce((a, g) => a + (Number(g.amount) || 0), 0) +
		(petCount ?? 0);

	const orderByTile = new Map<string, number>();
	duoNodeRefs().forEach((ref, i) => orderByTile.set(ref.id, i));

	interface Group {
		tile_id: string;
		tile_name: string;
		tile_img: string | null;
		faq_html: string | null;
		required: number;
		order: number;
		status: SubmissionStatus;
		approved: number;
		submissions: Array<{
			id: string;
			proof_urls: string[];
			quantity: number;
			submitted_at: string;
			status: SubmissionStatus;
			submitted_by: string;
			reviewed_by_name: string | null;
		}>;
	}

	const groupsMap = new Map<string, Group>();
	const approvedByTile: Record<string, number> = {};
	const pendingByTile: Record<string, number> = {};

	for (const s of subs) {
		if (!DUO_TILE_IDS.has(s.target_id)) continue;
		let g = groupsMap.get(s.target_id);
		if (!g) {
			g = {
				tile_id: s.target_id,
				tile_name: getDuoTileName(s.target_id) ?? s.target_id,
				tile_img: getDuoTileImg(s.target_id),
				faq_html: faqToHtml(getDuoTileFaq(s.target_id)),
				required: getDuoTileRequired(s.target_id),
				order: orderByTile.get(s.target_id) ?? 999,
				status: 'rejected',
				approved: 0,
				submissions: []
			};
			groupsMap.set(s.target_id, g);
		}
		const qty = Math.max(1, Number(s.quantity) || 1);
		g.submissions.push({
			id: s.id,
			proof_urls: s.proof_urls ?? [],
			quantity: qty,
			submitted_at: s.submitted_at,
			status: s.status,
			submitted_by: s.submitter ? (s.submitter.rsn ?? s.submitter.discord_username) : 'unknown',
			reviewed_by_name: s.reviewer ? (s.reviewer.rsn ?? s.reviewer.discord_username) : null
		});
		// Sum quantities (one proof can cover several) — drives the tile's done/required status.
		if (s.status === 'approved') {
			g.approved += qty;
			approvedByTile[s.target_id] = (approvedByTile[s.target_id] ?? 0) + qty;
		} else if (s.status === 'pending') {
			pendingByTile[s.target_id] = (pendingByTile[s.target_id] ?? 0) + qty;
		}
	}

	for (const g of groupsMap.values()) {
		if (g.approved >= g.required) g.status = 'approved';
		else if (g.submissions.some((x) => x.status === 'pending')) g.status = 'pending';
		else if (g.submissions.some((x) => x.status === 'approved')) g.status = 'approved';
		else g.status = 'rejected';
	}

	const groups = Array.from(groupsMap.values()).sort((a, b) => a.order - b.order);

	const requiredByTile: Record<string, number> = {};
	for (const ref of duoNodeRefs()) requiredByTile[ref.id] = getDuoTileRequired(ref.id);
	const prog = computeProgress({
		approvedByTile,
		pendingByTile,
		requiredByTile,
		choiceByFloorSection,
		swapByPositionKey
	});
	const tilesComplete = Object.values(prog.nodeState).filter((s) => s === 'complete').length;

	const stage = prog.stages[prog.currentStageIndex];
	const currentFloor = stage?.floor ?? null;
	let bonusUsed = 0;
	for (const f of Object.keys(swapsUsedByFloor)) bonusUsed += Math.max(0, swapsUsedByFloor[Number(f)] - SWAPS_PER_FLOOR);
	const bonusRemaining = Math.max(0, bonusGranted - bonusUsed);
	const baseRemaining = currentFloor ? Math.max(0, SWAPS_PER_FLOOR - (swapsUsedByFloor[currentFloor] ?? 0)) : 0;

	return {
		event: { slug: event.slug, name: event.name },
		team: { id: team.id, name: team.name ?? 'Unnamed team', members },
		groups,
		summary: {
			tilesComplete,
			totalSubmissions: subs.length,
			stage: stageLabel(prog.stages[prog.currentStageIndex]),
			finished: prog.currentStageIndex >= prog.stages.length
		},
		swaps: {
			available: baseRemaining + bonusRemaining,
			baseRemaining,
			bonusRemaining,
			bonusGranted,
			used: Object.values(swapsUsedByFloor).reduce((a, b) => a + b, 0),
			perFloor: SWAPS_PER_FLOOR,
			currentFloor
		}
	};
};

async function setSubmissionStatus(
	params: { slug: string; teamId: string },
	locals: App.Locals,
	request: Request,
	newStatus: 'approved' | 'rejected'
) {
	if (!locals.user) throw redirect(303, '/');
	if (!isAdmin(locals.user)) return fail(403, { error: 'Not allowed' });
	if (params.slug !== DUO_WOLF_EVENT_SLUG) throw error(404, 'Not found');

	const { data: event } = await db()
		.from('vs_events')
		.select('id')
		.eq('slug', params.slug)
		.maybeSingle();
	if (!event) return fail(404, { error: 'Event not found' });

	const form = await request.formData();
	const submissionId = form.get('submission_id')?.toString() ?? '';
	const note = form.get('note')?.toString().trim() || null;
	if (!submissionId) return fail(400, { error: 'Missing submission_id' });

	const { error: upErr } = await db()
		.from('vs_submissions')
		.update({
			status: newStatus,
			reviewed_at: new Date().toISOString(),
			reviewed_by: locals.user.id,
			review_note: note
		})
		.eq('id', submissionId)
		.eq('event_id', event.id)
		.eq('team_id', params.teamId);
	if (upErr) return fail(500, { error: upErr.message });

	return { ok: true, submission_id: submissionId, status: newStatus };
}

export const actions: Actions = {
	approve: ({ params, locals, request }) => setSubmissionStatus(params, locals, request, 'approved'),
	reject: ({ params, locals, request }) => setSubmissionStatus(params, locals, request, 'rejected'),

	// Grant bonus swaps (e.g. a pet relevant to the team's current tile). These persist
	// across floors and are consumed only after a floor's 2 base swaps are used.
	grantSwap: async ({ params, locals, request }) => {
		if (!locals.user) throw redirect(303, '/');
		if (!isAdmin(locals.user)) return fail(403, { error: 'Not allowed' });
		if (params.slug !== DUO_WOLF_EVENT_SLUG) throw error(404, 'Not found');

		const { data: event } = await db().from('vs_events').select('id').eq('slug', params.slug).maybeSingle();
		if (!event) return fail(404, { error: 'Event not found' });

		const form = await request.formData();
		const amount = Math.max(1, Math.min(10, Math.floor(Number(form.get('amount') ?? 1)) || 1));
		const note = form.get('note')?.toString().trim() || null;

		const { error: insErr } = await db().from('vs_team_swap_grants').insert({
			event_id: event.id,
			team_id: params.teamId,
			amount,
			note,
			granted_by: locals.user.id
		});
		if (insErr) return fail(500, { error: insErr.message });

		return { ok: true, granted: amount };
	}
};
