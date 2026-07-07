import { db } from './db';
import { isAdmin } from './auth';
import type { SessionUser } from './auth';
import { isClanMember } from './clan';
import { renderMarkdown } from '$lib/markdown';
import { BINGO_EVENT_SLUG } from '$lib/bingo/config';
import {
	SEQUENTIAL_EVENT_KIND,
	isTaskEvent,
	isEventLive,
	isEventUpcoming,
	isEventEnded,
	rewardLabel,
	type SubmissionStatus
} from '$lib/events/simple';

// Builds the generic task-event detail (/event/[slug]) for /api/event/[slug].
// The page has NO server load — its universal load fires this fetch without
// awaiting, so navigation lands instantly on a skeleton; not-found and the
// bespoke-page redirects come back in the payload and the client acts on them.

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

export async function getEvent(slug: string): Promise<EventRow | null> {
	const { data } = await db()
		.from('vs_events')
		.select('id, slug, name, kind, description, status, starts_at, ends_at')
		.eq('slug', slug)
		.maybeSingle();
	return (data as EventRow | null) ?? null;
}

// Open objective tasks for an event, oldest first (creation order).
export async function getEventTasks(eventId: string) {
	const { data } = await db()
		.from('vs_tasks')
		.select('id, name, description, vp_reward, pack_reward')
		.eq('event_id', eventId)
		.eq('status', 'open')
		.order('created_at', { ascending: true });
	return data ?? [];
}

export type EventTaskDetail =
	| { kind: 'not_found' }
	| { kind: 'redirect'; to: string }
	| (Awaited<ReturnType<typeof buildOk>> & { kind: 'ok' });

export async function buildEventTaskDetail(user: SessionUser, slug: string): Promise<EventTaskDetail> {
	const ev = await getEvent(slug);
	if (!ev) return { kind: 'not_found' };

	// Send the bespoke event types to their own pages.
	if (ev.slug === BINGO_EVENT_SLUG || ev.kind === 'bingo') return { kind: 'redirect', to: `/bingo/${ev.slug}` };
	if (ev.kind === 'duo') return { kind: 'redirect', to: `/events/${ev.slug}` };
	if (!isTaskEvent(ev.kind)) return { kind: 'not_found' };

	const admin = isAdmin(user);
	if ((ev.status === 'draft' || ev.status === 'preview') && !admin) {
		return { kind: 'not_found' };
	}

	const ok = await buildOk(user, ev, admin);
	return { kind: 'ok', ...ok };
}

async function buildOk(user: SessionUser, ev: EventRow, admin: boolean) {
	// Admin previewing a not-yet-open event → allow them to test the full flow.
	const adminPreview = admin && (ev.status === 'draft' || ev.status === 'preview');

	const [tasks, memberOfClan] = await Promise.all([
		getEventTasks(ev.id),
		isClanMember(user.discord_id, user.rsn)
	]);

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
			.or(`user_id.eq.${user.id},discord_id.eq.${user.discord_id}`)
			.order('submitted_at', { ascending: false });
		for (const r of (data ?? []) as unknown as MySubRow[]) {
			const arr = byTask.get(r.task_id) ?? [];
			arr.push(r);
			byTask.set(r.task_id, arr);
		}
	}

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
		// Open but past its end time → shown as "Ended" (no submitting).
		ended: isEventEnded(ev.status, ev.ends_at),
		canSubmit: adminPreview || (memberOfClan && isEventLive(ev.status, ev.starts_at, ev.ends_at))
	};
}
