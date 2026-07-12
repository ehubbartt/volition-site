import { redirect, fail } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { isClanMember } from '$lib/server/clan';
import { isAdmin } from '$lib/server/auth';
import { renderMarkdown } from '$lib/markdown';
import { createSubmission, decideSubmissions, revokeSubmissions } from '$lib/server/submissions';
import { loadActiveTaskInstances } from '$lib/server/tasks';
import { BINGO_BUCKET } from '$lib/bingo/config';
import type { Actions, PageServerLoad } from './$types';

type SubmissionStatus = 'pending' | 'approved' | 'rejected';

interface MySubRow {
	id: string;
	task_id: string;
	proof_urls: string[] | null;
	submitted_at: string;
	status: SubmissionStatus;
	review_note: string | null;
	reviewer: { rsn: string | null; discord_username: string } | null;
}

// Admin-only "every submission for this task" row (the see-all + un-approve view).
interface AdminSubRow {
	id: string;
	task_id: string;
	proof_urls: string[] | null;
	submitted_at: string;
	status: SubmissionStatus;
	review_note: string | null;
	submitter_name: string | null;
	vs_users: { rsn: string | null; discord_username: string; account_type: string | null } | null;
	reviewer: { rsn: string | null; discord_username: string } | null;
}

export interface AdminSub {
	id: string;
	proof_urls: string[];
	submitted_at: string;
	status: SubmissionStatus;
	submitter: string;
	account_type: string | null;
	reviewed_by_name: string | null;
	review_note: string | null;
}

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) throw redirect(303, '/');
	if (!locals.user.rsn || !locals.user.clan_allegiance || !locals.user.account_type) {
		throw redirect(303, '/onboarding');
	}

	const memberOfClan = await isClanMember(locals.user);
	const admin = isAdmin(locals.user);
	const instances = await loadActiveTaskInstances();

	// This player's submissions across every active task instance, by event_id.
	// Match the site account (user_id) OR Discord id (a submission the bot made
	// for this player from Discord has discord_id but no user_id).
	const byEvent = new Map<
		string,
		Array<{
			id: string;
			proof_urls: string[];
			submitted_at: string;
			status: SubmissionStatus;
			reviewed_by_name: string | null;
			review_note: string | null;
		}>
	>();

	if (instances.length > 0) {
		const ids = instances.map((i) => i.id);
		const { data } = await db()
			.from('vs_submissions')
			.select(
				'id, task_id, proof_urls, submitted_at, status, review_note, reviewer:vs_users!reviewed_by(rsn, discord_username)'
			)
			.in('task_id', ids)
			.or(`user_id.eq.${locals.user.id},discord_id.eq.${locals.user.discord_id}`)
			.order('submitted_at', { ascending: false });

		for (const r of (data ?? []) as unknown as MySubRow[]) {
			const arr = byEvent.get(r.task_id) ?? [];
			arr.push({
				id: r.id,
				proof_urls: r.proof_urls ?? [],
				submitted_at: r.submitted_at,
				status: r.status,
				reviewed_by_name: r.reviewer ? (r.reviewer.rsn ?? r.reviewer.discord_username) : null,
				review_note: r.review_note ?? null
			});
			byEvent.set(r.task_id, arr);
		}
	}

	// Admins also get EVERY submission per task (the see-all + un-approve community view).
	const adminByTask = new Map<string, AdminSub[]>();
	if (admin && instances.length > 0) {
		const ids = instances.map((i) => i.id);
		const { data } = await db()
			.from('vs_submissions')
			.select(
				'id, task_id, proof_urls, submitted_at, status, review_note, submitter_name, vs_users!user_id(rsn, discord_username, account_type), reviewer:vs_users!reviewed_by(rsn, discord_username)'
			)
			.in('task_id', ids)
			.order('submitted_at', { ascending: true });

		for (const r of (data ?? []) as unknown as AdminSubRow[]) {
			const arr = adminByTask.get(r.task_id) ?? [];
			arr.push({
				id: r.id,
				proof_urls: r.proof_urls ?? [],
				submitted_at: r.submitted_at,
				status: r.status,
				submitter: r.vs_users ? (r.vs_users.rsn ?? r.vs_users.discord_username) : (r.submitter_name ?? 'Discord member'),
				account_type: r.vs_users?.account_type ?? null,
				reviewed_by_name: r.reviewer ? (r.reviewer.rsn ?? r.reviewer.discord_username) : null,
				review_note: r.review_note ?? null
			});
			adminByTask.set(r.task_id, arr);
		}
	}

	return {
		isClanMember: memberOfClan,
		isAdmin: admin,
		tasks: instances.map((i) => ({
			id: i.id,
			name: i.name,
			description_html: renderMarkdown(i.description),
			reward: i.reward,
			endsAt: i.endsAt,
			mySubmissions: byEvent.get(i.id) ?? [],
			allSubmissions: admin ? (adminByTask.get(i.id) ?? []) : []
		}))
	};
};

export const actions: Actions = {
	submit: async ({ locals, request }) => {
		if (!locals.user) throw redirect(303, '/');
		if (!(await isClanMember(locals.user))) {
			return fail(403, { error: 'Only Volition clan members can submit tasks.' });
		}

		const form = await request.formData();
		const eventId = form.get('event_id')?.toString() ?? '';
		if (!eventId) return fail(400, { error: 'Missing task' });

		// Only allow submitting to a currently-active task instance.
		const instances = await loadActiveTaskInstances();
		const inst = instances.find((i) => i.id === eventId);
		if (!inst) return fail(400, { error: 'That task is not active right now.' });

		const files = form.getAll('proof').filter((f): f is File => f instanceof File && f.size > 0);

		const result = await createSubmission({
			taskId: inst.id,
			userId: locals.user.id,
			discordId: locals.user.discord_id,
			submitterName: locals.user.rsn ?? locals.user.discord_username,
			targetId: inst.id,
			targetLabel: inst.name,
			files
		});
		if (!result.ok) return fail(400, { error: result.error });

		return { ok: true, action: 'submit' as const, event_id: eventId };
	},

	remove: async ({ locals, request }) => {
		if (!locals.user) throw redirect(303, '/');

		const form = await request.formData();
		const submissionId = form.get('submission_id')?.toString() ?? '';
		if (!submissionId) return fail(400, { error: 'Missing submission_id' });

		// Owner-only, pending-only. (Bot/Discord submissions have no user_id, so
		// they can't be removed from the site — only the submitter's own site rows.)
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
