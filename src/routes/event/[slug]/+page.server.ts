import { redirect, fail } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { isAdmin } from '$lib/server/auth';
import { isClanMember } from '$lib/server/clan';
import { createSubmission } from '$lib/server/submissions';
import { BINGO_BUCKET } from '$lib/bingo/config';
import { getEvent, getEventTasks } from '$lib/server/eventTaskPage';
import {
	SEQUENTIAL_EVENT_KIND,
	isTaskEvent,
	isEventLive,
	isEventUpcoming
} from '$lib/events/simple';
import type { Actions } from './$types';

// ACTIONS ONLY — this page has no server load. Its data comes from
// /api/event/[slug] (built in $lib/server/eventTaskPage.ts) via the universal
// load in +page.ts, so navigating here never waits on the server.

export const actions: Actions = {
	submitTask: async ({ locals, request, params }) => {
		if (!locals.user) throw redirect(303, '/');

		const ev = await getEvent(params.slug);
		if (!ev || !isTaskEvent(ev.kind)) return fail(404, { error: 'Event not found' });

		// Admins can test-submit to a draft/preview event; everyone else needs a LIVE
		// event (open AND past its start time) AND clan membership.
		const adminPreview = isAdmin(locals.user) && (ev.status === 'draft' || ev.status === 'preview');
		if (!adminPreview) {
			if (!isEventLive(ev.status, ev.starts_at, ev.ends_at)) {
				return fail(400, {
					error:
						ev.status !== 'open'
							? 'This event is not open for submissions.'
							: isEventUpcoming(ev.status, ev.starts_at)
								? "This event hasn't started yet."
								: 'This event has ended — submissions are closed.'
				});
			}
			if (!(await isClanMember(locals.user.discord_id, locals.user.rsn))) {
				return fail(403, { error: 'Only Volition clan members can submit.' });
			}
		}

		const form = await request.formData();
		const taskId = form.get('task_id')?.toString() ?? '';
		if (!taskId) return fail(400, { error: 'Missing task' });

		// The task must belong to THIS event and be open.
		const { data: task } = await db()
			.from('vs_tasks')
			.select('id, name')
			.eq('id', taskId)
			.eq('event_id', ev.id)
			.eq('status', 'open')
			.maybeSingle();
		if (!task) return fail(400, { error: 'That task is not part of this event.' });

		// Sequential events: enforce the lock server-side — every task before this one
		// (in creation order) must already be approved for this player.
		if (ev.kind === SEQUENTIAL_EVENT_KIND) {
			const ordered = await getEventTasks(ev.id);
			const idx = ordered.findIndex((t) => t.id === taskId);
			const priorIds = ordered.slice(0, Math.max(0, idx)).map((t) => t.id);
			if (priorIds.length > 0) {
				const { data: approved } = await db()
					.from('vs_submissions')
					.select('task_id')
					.in('task_id', priorIds)
					.eq('status', 'approved')
					.or(`user_id.eq.${locals.user.id},discord_id.eq.${locals.user.discord_id}`);
				const done = new Set((approved ?? []).map((r) => r.task_id as string));
				if (!priorIds.every((id) => done.has(id))) {
					return fail(400, { error: 'Complete the earlier tasks first.' });
				}
			}
		}

		const files = form.getAll('proof').filter((f): f is File => f instanceof File && f.size > 0);
		const result = await createSubmission({
			taskId: task.id,
			userId: locals.user.id,
			discordId: locals.user.discord_id,
			submitterName: locals.user.rsn ?? locals.user.discord_username,
			targetId: task.id,
			targetLabel: task.name,
			files
		});
		if (!result.ok) return fail(400, { error: result.error });

		return { ok: true, action: 'submit' as const, task_id: taskId };
	},

	removeTask: async ({ locals, request }) => {
		if (!locals.user) throw redirect(303, '/');

		const form = await request.formData();
		const submissionId = form.get('submission_id')?.toString() ?? '';
		if (!submissionId) return fail(400, { error: 'Missing submission_id' });

		// Owner-only, pending-only.
		const { data: existing } = await db()
			.from('vs_submissions')
			.select('id, proof_paths, status')
			.eq('id', submissionId)
			.eq('user_id', locals.user.id)
			.maybeSingle();
		if (!existing) return fail(404, { error: 'Submission not found' });
		if (existing.status !== 'pending') {
			return fail(400, { error: 'Only pending submissions can be removed' });
		}

		const { error: delErr } = await db().from('vs_submissions').delete().eq('id', existing.id);
		if (delErr) return fail(500, { error: delErr.message });

		const paths = (existing.proof_paths ?? []) as string[];
		if (paths.length) await db().storage.from(BINGO_BUCKET).remove(paths);

		return { ok: true, action: 'remove' as const, submission_id: submissionId };
	}
};
