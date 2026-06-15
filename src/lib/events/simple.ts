// CLIENT-SAFE: shared types + helpers for TASK EVENTS — admin-creatable events
// made of multiple solo, image-proof tasks, each with its own reward. Two unlock
// modes (event.kind): 'simple' = complete any task any time; 'sequential' =
// complete tasks in order (each unlocks the next). An event's objectives are
// vs_tasks rows (kind=EVENT_TASK_KIND, event_id = the event) so the whole
// submission/review/reward pipeline is reused. DB reads/writes live in the route
// loaders + $lib/server/submissions.ts.

// vs_events.kind markers for the two task-event unlock modes (see migration 0034).
export const SIMPLE_EVENT_KIND = 'simple'; // open: any task, any time
export const SEQUENTIAL_EVENT_KIND = 'sequential'; // linear: one task unlocks the next

// The kinds the generic /event/[slug] page renders (both task-based). bingo + duo
// keep their bespoke pages; 'custom' is a bare/legacy event with no template page.
export type TaskEventKind = 'simple' | 'sequential';
export function isTaskEvent(kind: string | null | undefined): kind is TaskEventKind {
	return kind === SIMPLE_EVENT_KIND || kind === SEQUENTIAL_EVENT_KIND;
}

// Event-type choices for the admin creator dropdown (task-based types only; the
// "advanced/custom" path is handled separately in the create form).
export const EVENT_TYPE_OPTIONS: { value: TaskEventKind; label: string; hint: string }[] = [
	{ value: 'simple', label: 'Open — complete any task, any time', hint: 'Players can do the tasks in any order.' },
	{ value: 'sequential', label: 'Sequential — complete tasks in order', hint: 'Each task unlocks only after the previous one is approved.' }
];

export function eventTypeLabel(kind: string | null | undefined): string {
	if (kind === SEQUENTIAL_EVENT_KIND) return 'Sequential';
	if (kind === SIMPLE_EVENT_KIND) return 'Open';
	return kind ?? 'event';
}

// vs_tasks.kind for an event's objectives. Deliberately NOT one of the To Do task
// kinds (weekly_task/daily_task/custom_task), so event objectives are excluded from
// the /tasks list (loadActiveTaskInstances) AND the bot's task pollers automatically.
export const EVENT_TASK_KIND = 'event_task';

export type SubmissionStatus = 'pending' | 'approved' | 'rejected';

// One objective of a simple event + this player's standing on it.
export interface EventTask {
	id: string; // vs_tasks.id — the submission target/task_id
	name: string;
	description_html: string | null;
	reward: string | null; // display label, e.g. "5 VP + White Pack"
	mySubmissions: Array<{
		id: string;
		proof_urls: string[];
		submitted_at: string;
		status: SubmissionStatus;
		reviewed_by_name: string | null;
		review_note: string | null;
	}>;
	// Derived: a task is "done" for the player once they have an approved submission.
	done: boolean;
	// Sequential events only: true when an earlier task isn't done yet, so this one
	// can't be submitted to. Always false for 'simple' (open) events.
	locked: boolean;
}

// Time-aware "open": an OPEN event is only LIVE (submittable + announced in Discord)
// while it's within its window — its start time has arrived AND (if it has an end) its
// end hasn't passed yet. A null/invalid start means "started"; a null/invalid end means
// "no end" (stays live until an admin closes it). This lets admins publish an event
// (status=open) that's visible-but-upcoming until `starts_at`, goes live automatically,
// then stops accepting submissions once `ends_at` passes — without needing the admin to
// flip the status. bingo/duo keep their own timing.
export function isEventLive(
	status: string | null | undefined,
	startsAt: string | null | undefined,
	endsAt: string | null | undefined = null,
	now: number = Date.now()
): boolean {
	if (status !== 'open') return false;
	if (startsAt) {
		const s = new Date(startsAt).getTime();
		if (!Number.isNaN(s) && s > now) return false; // not started yet
	}
	if (endsAt) {
		const e = new Date(endsAt).getTime();
		if (!Number.isNaN(e) && now > e) return false; // already ended
	}
	return true;
}

// Published (open) but not started yet → shown to players as "Upcoming".
export function isEventUpcoming(
	status: string | null | undefined,
	startsAt: string | null | undefined,
	now: number = Date.now()
): boolean {
	if (status !== 'open' || !startsAt) return false;
	const s = new Date(startsAt).getTime();
	return !Number.isNaN(s) && s > now;
}

// Open but past its end time → over (an admin just hasn't flipped status to closed yet).
// The complement of "started" — used to show an "ended" notice + block late submissions.
export function isEventEnded(
	status: string | null | undefined,
	endsAt: string | null | undefined,
	now: number = Date.now()
): boolean {
	if (status !== 'open' || !endsAt) return false;
	const e = new Date(endsAt).getTime();
	return !Number.isNaN(e) && now > e;
}

// A task's reward, for display: a card pack and/or VP (either, both, or none).
// Mirrors rewardLabel() in $lib/server/tasks.ts so the admin + player views match.
export function rewardLabel(vp: number | null | undefined, pack: string | null | undefined): string | null {
	const parts: string[] = [];
	const p = typeof pack === 'string' ? pack.trim() : '';
	if (p) parts.push(p);
	const v = Number(vp ?? 0);
	if (v > 0) parts.push(`${v} VP`);
	return parts.length ? parts.join(' + ') : null;
}

// RSN/name → URL-safe event slug. Uniqueness is enforced server-side (the slug
// column is unique); callers append a suffix on collision.
export function slugify(name: string): string {
	return name
		.toLowerCase()
		.trim()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 60)
		.replace(/-+$/g, '');
}
