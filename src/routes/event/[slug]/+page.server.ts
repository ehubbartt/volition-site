import { redirect, error, fail } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { isAdmin } from '$lib/server/auth';
import { isClanMember } from '$lib/server/clan';
import { renderMarkdown } from '$lib/markdown';
import { createSubmission } from '$lib/server/submissions';
import { BINGO_BUCKET, BINGO_EVENT_SLUG } from '$lib/bingo/config';
import {
	SEQUENTIAL_EVENT_KIND,
	isTaskEvent,
	isEventLive,
	isEventUpcoming,
	rewardLabel,
	type SubmissionStatus
} from '$lib/events/simple';
import type { Actions, PageServerLoad } from './$types';

// Generic, template-driven event detail page. Today it serves SIMPLE events (a
// flat list of solo, image-proof objective tasks with per-task rewards). Future
// templates branch on event.kind here. The bespoke duo (/events/[slug]) and bingo
// (/bingo/[slug]) pages are unchanged; this route hosts everything else.

interface EventRow {
	id: string;
	slug: string;
	name: string;
	kind: string;
	description: string | null;
	status: string;
	starts_at: string | null;
	ends_at: string | null;
}

interface MySubRow {
	id: string;
	task_id: string;
	proof_urls: string[] | null;
	submitted_at: string;
	status: SubmissionStatus;
	review_note: string | null;
	reviewer: { rsn: string | null; discord_username: string } | null;
}

async function getEvent(slug: string): Promise<EventRow | null> {
	const { data } = await db()
		.from('vs_events')
		.select('id, slug, name, kind, description, status, starts_at, ends_at')
		.eq('slug', slug)
		.maybeSingle();
	return (data as EventRow | null) ?? null;
}

// Open objective tasks for an event, oldest first (creation order).
async function getEventTasks(eventId: string) {
	const { data } = await db()
		.from('vs_tasks')
		.select('id, name, description, vp_reward, pack_reward')
		.eq('event_id', eventId)
		.eq('status', 'open')
		.order('created_at', { ascending: true });
	return data ?? [];
}

export const load: PageServerLoad = async ({ params, locals }) => {
	if (!locals.user) throw redirect(303, '/');
	if (!locals.user.rsn || !locals.user.clan_allegiance || !locals.user.account_type) {
		throw redirect(303, '/onboarding');
	}

	const ev = await getEvent(params.slug);
	if (!ev) throw error(404, 'Event not found');

	// Send the bespoke event types to their own pages.
	if (ev.slug === BINGO_EVENT_SLUG || ev.kind === 'bingo') throw redirect(303, `/bingo/${ev.slug}`);
	if (ev.kind === 'duo') throw redirect(303, `/events/${ev.slug}`);
	if (!isTaskEvent(ev.kind)) throw error(404, 'Event not found');

	const admin = isAdmin(locals.user);
	if ((ev.status === 'draft' || ev.status === 'preview') && !admin) {
		throw error(404, 'Event not found');
	}
	// Admin previewing a not-yet-open event → allow them to test the full flow.
	const adminPreview = admin && (ev.status === 'draft' || ev.status === 'preview');

	const tasks = await getEventTasks(ev.id);

	// This player's submissions across the event's tasks, grouped by task_id. Match
	// the site account (user_id) OR Discord id (bot-made rows have discord_id only).
	const byTask = new Map<string, MySubRow[]>();
	if (tasks.length > 0) {
		const ids = tasks.map((t) => t.id);
		const { data } = await db()
			.from('vs_submissions')
			.select(
				'id, task_id, proof_urls, submitted_at, status, review_note, reviewer:vs_users!reviewed_by(rsn, discord_username)'
			)
			.in('task_id', ids)
			.or(`user_id.eq.${locals.user.id},discord_id.eq.${locals.user.discord_id}`)
			.order('submitted_at', { ascending: false });
		for (const r of (data ?? []) as unknown as MySubRow[]) {
			const arr = byTask.get(r.task_id) ?? [];
			arr.push(r);
			byTask.set(r.task_id, arr);
		}
	}

	const memberOfClan = await isClanMember(locals.user.discord_id, locals.user.rsn);

	// Sequential events unlock tasks in creation order: a task is locked until every
	// task before it is done (approved). Open events never lock.
	const isSequential = ev.kind === SEQUENTIAL_EVENT_KIND;
	let prevAllDone = true; // first task is always unlocked

	const eventTasks = tasks.map((t) => {
		const subs = byTask.get(t.id) ?? [];
		const done = subs.some((s) => s.status === 'approved');
		const locked = isSequential ? !prevAllDone : false;
		prevAllDone = prevAllDone && done; // a later task unlocks only once this is done
		return {
			id: t.id,
			name: t.name,
			description_html: renderMarkdown(t.description),
			reward: rewardLabel(t.vp_reward, t.pack_reward),
			done,
			locked,
			mySubmissions: subs.map((s) => ({
				id: s.id,
				proof_urls: s.proof_urls ?? [],
				submitted_at: s.submitted_at,
				status: s.status,
				reviewed_by_name: s.reviewer ? (s.reviewer.rsn ?? s.reviewer.discord_username) : null,
				review_note: s.review_note ?? null
			}))
		};
	});

	return {
		event: {
			slug: ev.slug,
			name: ev.name,
			kind: ev.kind,
			sequential: isSequential,
			description_html: renderMarkdown(ev.description),
			status: ev.status,
			starts_at: ev.starts_at,
			ends_at: ev.ends_at
		},
		tasks: eventTasks,
		completedCount: eventTasks.filter((t) => t.done).length,
		isClanMember: memberOfClan,
		// Admins can test-submit while the event is still draft/preview (it's not
		// visible to players yet); everyone else submits only to a LIVE event (open
		// AND past its start time) as a clan member.
		adminPreview,
		// Open but not started yet → shown to players as "Upcoming" (no submitting).
		upcoming: isEventUpcoming(ev.status, ev.starts_at),
		canSubmit: adminPreview || (memberOfClan && isEventLive(ev.status, ev.starts_at))
	};
};

export const actions: Actions = {
	submitTask: async ({ locals, request, params }) => {
		if (!locals.user) throw redirect(303, '/');

		const ev = await getEvent(params.slug);
		if (!ev || !isTaskEvent(ev.kind)) return fail(404, { error: 'Event not found' });

		// Admins can test-submit to a draft/preview event; everyone else needs a LIVE
		// event (open AND past its start time) AND clan membership.
		const adminPreview = isAdmin(locals.user) && (ev.status === 'draft' || ev.status === 'preview');
		if (!adminPreview) {
			if (!isEventLive(ev.status, ev.starts_at)) {
				return fail(400, {
					error:
						ev.status === 'open'
							? "This event hasn't started yet."
							: 'This event is not open for submissions.'
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
