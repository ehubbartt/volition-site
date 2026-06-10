import { redirect, error, fail } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { isAdmin } from '$lib/server/auth';
import { grantPlayerVp } from '$lib/server/playerStats';
import { loadPendingReview, decideSubmissions } from '$lib/server/submissions';
import type { SubmissionSource, ReviewDecision } from '$lib/submissions';
import type { Actions, PageServerLoad } from './$types';

const SOURCES: SubmissionSource[] = ['generic', 'bingo', 'team'];

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) throw redirect(303, '/');
	if (!isAdmin(locals.user)) throw error(403, 'Not allowed');

	const { items, events, stats } = await loadPendingReview();
	return { items, events, stats };
};

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

export const actions: Actions = {
	decide: async ({ locals, request }) => {
		if (!locals.user) throw redirect(303, '/');
		if (!isAdmin(locals.user)) return fail(403, { error: 'Not allowed' });

		const form = await request.formData();
		const source = form.get('source')?.toString() ?? '';
		const ids = (form.get('ids')?.toString() ?? '').split(',').filter(Boolean);
		const decision = form.get('decision')?.toString() ?? '';
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
			const pending = (rows ?? []).filter(
				(r) => (r as { status?: string }).status === 'pending' && (r as { task_id?: string }).task_id
			) as Array<{
				task_id: string;
				user_id: string | null;
				discord_id: string | null;
				submitter_name: string | null;
			}>;
			if (pending.length > 0) {
				const r = pending[0];
				grantCtx = {
					taskId: r.task_id,
					userId: r.user_id ?? null,
					discordId: r.discord_id ?? null,
					name: r.submitter_name ?? null
				};
			}
		}

		const { error: dErr } = await decideSubmissions({
			source: source as SubmissionSource,
			ids,
			decision: decision as ReviewDecision,
			reviewerId: locals.user.id,
			note
		});
		if (dErr) return fail(500, { error: dErr });

		if (grantCtx) {
			try {
				await grantVpForApproval(grantCtx, ids);
			} catch (e) {
				console.error('[submissions] VP grant failed:', (e as Error).message);
			}
		}

		return { ok: true, decision, ids };
	}
};
