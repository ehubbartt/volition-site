// CLIENT-SAFE: shared types + helpers for "simple events" — an admin-creatable
// event template made of multiple solo, image-proof tasks, each with its own
// reward. An event's objectives are vs_tasks rows (kind=EVENT_TASK_KIND, event_id
// = the event) so the whole submission/review/reward pipeline is reused. The DB
// reads/writes live in the route loaders + $lib/server/submissions.ts.

// vs_events.kind marker for this template (see migration 0034). Future templates
// add their own kind value and branch in /event/[slug].
export const SIMPLE_EVENT_KIND = 'simple';

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
