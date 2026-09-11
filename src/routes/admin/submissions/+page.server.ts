import { redirect, fail } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { mintBombsForApprovedClaims } from '$lib/server/battleship';
import { isAdmin } from '$lib/server/auth';
import { grantPlayerVp } from '$lib/server/playerStats';
import { decideSubmissions, revokeSubmissions } from '$lib/server/submissions';
import {
	addBonus,
	confirmPiece,
	loadConnect4ById,
	rejectPieceFully,
	revokeProgressFor,
	sideForUser
} from '$lib/server/connect4';
import type { SubmissionSource, ReviewDecision } from '$lib/submissions';
import type { Actions } from './$types';

// ACTIONS ONLY — this page has no server load. Its data comes from
// /api/admin/submissions (built in $lib/server/admin/submissions.ts) via the
// universal load in +page.ts, so navigating here never waits on the server.

const SOURCES: SubmissionSource[] = ['generic', 'bingo', 'team'];

// Grant the event's vp_reward to the submitter the FIRST time one of their generic
// submissions for that event is approved. Idempotent: skips if they already had an
// approved row for the event (other than the ones just approved). Packs are granted
// bot-side; the site owns VP (see voli-disc-bot/jobs/siteSubmissionPoller.js).
async function grantVpForApproval(
	ctx: { taskId: string; userId: string | null; discordId: string | null; name: string | null },
	approvedIds: string[]
): Promise<void> {
	const { data: task } = await db()
		.from('vs_tasks')
		.select('vp_reward')
		.eq('id', ctx.taskId)
		.maybeSingle();
	const vp = Number((task as { vp_reward?: number } | null)?.vp_reward ?? 0);
	if (vp <= 0) return;

	// Already rewarded for this (task, submitter)?
	let priorQ = db()
		.from('vs_submissions')
		.select('id')
		.eq('task_id', ctx.taskId)
		.eq('status', 'approved')
		.not('id', 'in', `(${approvedIds.join(',')})`);
	priorQ = ctx.userId ? priorQ.eq('user_id', ctx.userId) : priorQ.eq('discord_id', ctx.discordId ?? '');
	const { data: prior } = await priorQ.limit(1);
	if (prior && prior.length > 0) return;

	// Prefer the linked vs_users rsn, else the cached submitter name.
	let rsn = ctx.name;
	if (ctx.userId) {
		const { data: u } = await db().from('vs_users').select('rsn').eq('id', ctx.userId).maybeSingle();
		rsn = (u as { rsn?: string | null } | null)?.rsn ?? rsn;
	}
	await grantPlayerVp(ctx.discordId, rsn, vp);
}

/**
 * Settle the board for Connect Four rows a decision just changed.
 *
 * The piece is already ON the board — a submission places it provisionally, so the race
 * was decided when the player submitted, not when an admin got to it. So approving only
 * has to confirm it, and rejecting has two very different meanings:
 *
 *   partial — the claim is probably fine, the evidence is not. The piece STAYS, which is
 *             the submitter's priority: they keep the tile while they fetch a better
 *             screenshot, and nobody can take it from under them.
 *   full    — the claim is not good. The piece is removed, the column shifts down, and
 *             the tile goes back into play through the requeue.
 */
/**
 * Turn an approved pet submission into a bonus award, once. Idempotent through
 * `vs_connect4_bonus.drop_key`, which is unique per event: re-approving after a revoke
 * cannot pay a second time.
 */
async function awardPet(
	eventId: string,
	submissionId: string,
	userId: string | null,
	label: string | null
): Promise<{ ok: boolean; error?: string }> {
	const snap = await loadConnect4ById(eventId);
	if (!snap) return { ok: false, error: 'No such game' };
	const side = userId ? await sideForUser(eventId, userId) : null;
	if (!side) return { ok: false, error: 'That submitter is not on a side' };

	const dropKey = `manual:submission:${submissionId}`;
	const { data: already } = await db()
		.from('vs_connect4_bonus')
		.select('id')
		.eq('event_id', eventId)
		.eq('drop_key', dropKey)
		.maybeSingle();
	if (already) return { ok: true };

	const res = await addBonus({
		eventId,
		side,
		points: snap.scoring.pet_points,
		kind: 'pet',
		itemName: (label ?? '').replace(/^Pet\s*—\s*/, '').trim() || null,
		byUserId: userId,
		note: 'submitted on the board',
		dropKey
	});
	return res.ok ? { ok: true } : { ok: false, error: res.error };
}

async function settleConnect4(ids: string[], outcome: 'approve' | 'partial' | 'full'): Promise<void> {
	const { data: rows } = await db()
		.from('vs_submissions')
		.select('id, event_id, target_id, user_id, target_label')
		.in('id', ids)
		.like('target_id', 'c4:%');
	for (const r of ((rows ?? []) as Array<{
		id: string;
		event_id: string | null;
		target_id: string;
		user_id: string | null;
		target_label: string | null;
	}>)) {
		if (!r.event_id) continue;

		// A PET pays points beside the board — no column, no piece. Approving is what
		// awards it; the two rejections have nothing to undo because nothing was placed
		// when it was submitted.
		if (r.target_id === 'c4:pet') {
			if (outcome === 'approve') {
				const res = await awardPet(r.event_id, r.id, r.user_id, r.target_label);
				if (!res.ok) console.warn(`[submissions] pet award ${r.id}: ${res.error}`);
			}
			continue;
		}

		if (outcome === 'approve') {
			const res = await confirmPiece(r.id);
			if (!res.ok) console.warn(`[submissions] confirm ${r.id}: ${res.error}`);
		} else if (outcome === 'full') {
			// Order matters only in that both must happen. The bank comes off FIRST because
			// it is the half that used to be missed entirely: a partial-cover claim places
			// no piece, so the piece rejection below is a no-op for it and the drops would
			// otherwise stay counted for a claim an admin just threw out.
			const gave = await revokeProgressFor(r.event_id, r.id);
			if (!gave.ok) console.warn(`[submissions] clear bank ${r.id}: ${gave.error}`);
			const res = await rejectPieceFully(r.event_id, r.id);
			if (!res.ok) console.warn(`[submissions] full reject ${r.id}: ${res.error}`);
		}
		// 'partial' deliberately touches nothing on the board.
	}
}

export const actions: Actions = {
	decide: async ({ locals, request }) => {
		if (!locals.user) throw redirect(303, '/');
		if (!isAdmin(locals.user)) return fail(403, { error: 'Not allowed' });

		const form = await request.formData();
		const source = form.get('source')?.toString() ?? '';
		const ids = (form.get('ids')?.toString() ?? '').split(',').filter(Boolean);
		const decision = form.get('decision')?.toString() ?? '';
		// Connect Four rejections come in two flavours; every other event sends neither
		// and lands on 'partial', which touches no board.
		const rejectKind = form.get('reject_kind')?.toString() ?? '';
		const note = form.get('note')?.toString().trim() || null;

		if (!SOURCES.includes(source as SubmissionSource)) {
			return fail(400, { error: 'Unknown source' });
		}
		if (decision !== 'approve' && decision !== 'reject') {
			return fail(400, { error: 'Bad decision' });
		}
		if (ids.length === 0) return fail(400, { error: 'No submissions selected' });

		// Capture the submitter + event BEFORE the status flip so we can grant VP
		// (generic task approvals only — bingo/team have their own scoring).
		let grantCtx: {
			taskId: string;
			userId: string | null;
			discordId: string | null;
			name: string | null;
		} | null = null;
		if (source === 'generic' && decision === 'approve') {
			const { data: rows } = await db()
				.from('vs_submissions')
				.select('task_id, user_id, discord_id, submitter_name, status')
				.in('id', ids);
			// Newly-approvable rows = pending OR rejected (re-approval after a revoke).
			const grantable = (rows ?? []).filter(
				(r) =>
					((r as { status?: string }).status === 'pending' ||
						(r as { status?: string }).status === 'rejected') &&
					(r as { task_id?: string }).task_id
			) as Array<{
				task_id: string;
				user_id: string | null;
				discord_id: string | null;
				submitter_name: string | null;
			}>;
			if (grantable.length > 0) {
				const r = grantable[0];
				grantCtx = {
					taskId: r.task_id,
					userId: r.user_id ?? null,
					discordId: r.discord_id ?? null,
					name: r.submitter_name ?? null
				};
			}
		}

		const { error: dErr, changedIds } = await decideSubmissions({
			source: source as SubmissionSource,
			ids,
			decision: decision as ReviewDecision,
			reviewerId: locals.user.id,
			note
		});
		if (dErr) return fail(500, { error: dErr });

		// Only grant VP if THIS request actually flipped at least one row to approved.
		// If another admin approved the same submission a moment earlier, our update
		// matched zero rows (changedIds empty) and we must not award again.
		// Connect Four: approval is what places the piece. Only for rows THIS request
		// flipped, so two admins approving at once cannot drop two pieces — and the
		// board's own unique(event_id, col, row) is the final arbiter anyway.
		if (source === 'generic' && (changedIds?.length ?? 0) > 0) {
			// `rejectKind` distinguishes the two rejections; approvals just confirm.
			const outcome =
				decision === 'approve' ? 'approve' : rejectKind === 'full' ? 'full' : 'partial';
			try {
				await settleConnect4(changedIds ?? ids, outcome);
			} catch (e) {
				console.error('[submissions] connect4 settle failed:', (e as Error).message);
			}
		}

		// Nothing matched. For a reject that almost always means the rows are already
		// APPROVED, and an approval has to be undone with Un-approve so the VP and pack are
		// reversed too — rejecting it here would skip all of that. Say so: this failing
		// silently is how a mistakenly-approved Connect Four tile stayed on the board while
		// the reviewer believed they had just rejected it.
		if ((changedIds?.length ?? 0) === 0) {
			return fail(409, {
				error:
					decision === 'reject'
						? 'Nothing to reject — those submissions are already approved. Un-approve them first, which also takes any Connect Four piece back off the board.'
						: 'Nothing to approve — those submissions were already approved, probably by another admin a moment ago. Reload the queue.'
			});
		}

		if (grantCtx && (changedIds?.length ?? 0) > 0) {
			try {
				await grantVpForApproval(grantCtx, changedIds ?? ids);
			} catch (e) {
				console.error('[submissions] VP grant failed:', (e as Error).message);
			}
		}

		// Battleship manual claims (members who can't run Dink) arm their bomb on
		// approval. Keyed on the submission id, so a revoke-then-re-approve mints nothing
		// further. Failures are logged, never fatal — the review itself already stood.
		if (decision === 'approve' && (changedIds?.length ?? 0) > 0) {
			try {
				await mintBombsForApprovedClaims(changedIds ?? ids);
			} catch (e) {
				console.error('[submissions] battleship bomb mint failed:', (e as Error).message);
			}
		}

		return { ok: true, decision, ids };
	},

	// Un-approve an already-approved submission group and reverse its rewards (VP here;
	// the pack reclaim + "reward removed" Discord notice are done bot-side via flags).
	revoke: async ({ locals, request }) => {
		if (!locals.user) throw redirect(303, '/');
		if (!isAdmin(locals.user)) return fail(403, { error: 'Not allowed' });

		const form = await request.formData();
		const source = form.get('source')?.toString() ?? '';
		const ids = (form.get('ids')?.toString() ?? '').split(',').filter(Boolean);
		const note = form.get('note')?.toString().trim() || null;

		if (!SOURCES.includes(source as SubmissionSource)) return fail(400, { error: 'Unknown source' });
		if (ids.length === 0) return fail(400, { error: 'No submissions selected' });

		const { error: rErr, revoked, revokedIds } = await revokeSubmissions({
			source: source as SubmissionSource,
			ids,
			reviewerId: locals.user.id,
			note
		});
		if (rErr) return fail(500, { error: rErr });

		// Un-approving a Connect Four claim has to come off the BOARD too. Without this the
		// row flipped to rejected and its piece stayed standing and confirmed — and since a
		// revoke leaves the row already 'rejected', the reject an admin reached for next
		// changed nothing either. A mistaken approval was unremovable.
		//
		// 'full' is what a revoke means: the claim is not good, so the piece goes, the
		// column shifts down, the tile returns to play and the banked drops come back.
		if (source === 'generic' && (revokedIds?.length ?? 0) > 0) {
			try {
				await settleConnect4(revokedIds ?? [], 'full');
			} catch (e) {
				console.error('[submissions] connect4 settle on revoke failed:', (e as Error).message);
			}
		}

		return { ok: true, decision: 'revoke', ids, revoked };
	}
};
