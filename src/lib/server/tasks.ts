import { db } from './db';
import type { SessionUser } from './auth';
import { isAdmin } from './auth';
import { isClanMember } from './clan';
import { countPendingReview } from './submissions';
import { getLastLootDate } from './playerStats';
import { getWeeklyFreePack, getWeeklyClaimAt, claimedThisWeek } from './weeklyPack';
import { BINGO_TILES } from './bingoTiles';
import { getBingoState } from '$lib/bingo/state';
import { BINGO_EVENT_SLUG, BINGO_ROW_COUNT } from '$lib/bingo/config';
import { SIMPLE_EVENT_KIND, SEQUENTIAL_EVENT_KIND, isEventLive } from '$lib/events/simple';
import { type PlayerTask, nextUtcMidnightIso, nextWeeklyResetIso, countOutstandingTasks } from '$lib/tasks';

// Aggregates a player's time-gated / recurring activities into one normalized
// PlayerTask[] for the /tasks page + the home summary card. Modeled on
// loadCalendarItems (calendar.ts): one Promise.all over the sources, then sort.
//
// Reads BOTH site tables (vs_*) and the bot's tables (events, players via
// getLastLootDate) over the shared anon Supabase client — consistent with the
// existing playerStats / clan reads (RLS off).

const BINGO_TILE_TOTAL = BINGO_TILES.length; // 48 (12 rows × 4 tiers + 12 bonus)
const DUO_WOLF_SLUG = 'duo-wolf';

// --- Recurring task instances (vs_events) ----------------------------------
// Weekly/daily/custom tasks are first-class vs_events rows: a TEMPLATE is the
// rotation pool (is_template=true), an INSTANCE is the active event players
// submit to (is_template=false, status='open'). The bot creates instances (on
// rotation, or via /event task|custom); the site reads + reviews them. Multiple
// instances can be active at once — they're all surfaced here and on /tasks/weekly.
export const TASK_KINDS = ['weekly_task', 'daily_task', 'custom_task'];

export interface ActiveTaskInstance {
	id: string; // vs_events.id — the submission event_id
	name: string;
	description: string | null;
	kind: string; // weekly_task | daily_task | custom_task
	endsAt: string | null;
	reward: string | null; // display label, e.g. "5 VP"
}

// A task's reward, for display: a card pack and/or VP (either, both, or none).
function rewardLabel(vpReward: unknown, packReward: unknown): string | null {
	const parts: string[] = [];
	const pack = typeof packReward === 'string' ? packReward.trim() : '';
	if (pack) parts.push(pack);
	const vp = Number(vpReward ?? 0);
	if (vp > 0) parts.push(`${vp} VP`);
	return parts.length ? parts.join(' + ') : null;
}

// Every currently-open task instance whose deadline hasn't passed, newest first.
// Shared by the To Do page and the /tasks/weekly submitter.
export async function loadActiveTaskInstances(): Promise<ActiveTaskInstance[]> {
	const nowIso = new Date().toISOString();
	const { data } = await db()
		.from('vs_tasks')
		.select('id, name, description, kind, vp_reward, pack_reward, ends_at')
		.eq('is_template', false)
		.eq('status', 'open')
		.in('kind', TASK_KINDS)
		.or(`ends_at.is.null,ends_at.gt.${nowIso}`)
		.order('starts_at', { ascending: false });

	return ((data ?? []) as Array<Record<string, unknown>>).map((r) => ({
		id: r.id as string,
		name: (r.name as string) || 'Task',
		description: (r.description as string | null) ?? null,
		kind: (r.kind as string) || 'weekly_task',
		endsAt: (r.ends_at as string | null) ?? null,
		reward: rewardLabel(r.vp_reward, r.pack_reward)
	}));
}

// --- Daily loot crate (site-native: players.last_loot_date) ----------------
async function dailyCrateTask(user: SessionUser): Promise<PlayerTask> {
	const lastLoot = await getLastLootDate(user.discord_id, user.rsn);
	const todayUtc = new Date().toISOString().slice(0, 10);
	const done = lastLoot === todayUtc;
	return {
		id: 'daily-crate',
		kind: 'daily',
		status: done ? 'done' : 'todo',
		title: 'Daily loot crate',
		description: done ? 'Claimed today' : 'Open your free crate',
		href: '/gamba',
		ctaLabel: done ? 'Go to crates' : 'Open crate',
		// Always the next UTC-midnight reset: when done it's "resets in", when not
		// it's "time left" to still claim today's free crate before it rolls over.
		resetAt: nextUtcMidnightIso(),
		reward: 'VP + item drops'
	};
}

// --- Weekly free pack (site-native: vs_card_packs.weekly_free + claim) -------
// One claimable card per week for clan members (resets Monday 00:00 UTC), like the
// daily crate but for a pack. Only shown when an admin has flagged a weekly pack AND
// the user is a clan member; claimed inline on /tasks (?/claimWeeklyPack).
async function weeklyPackTask(user: SessionUser): Promise<PlayerTask | null> {
	// The three lookups are independent — fetch together and apply the same gates
	// after (the extra single-row reads when a gate fails are cheaper than chaining).
	const [pack, member, claimAt] = await Promise.all([
		getWeeklyFreePack(),
		isClanMember(user.discord_id, user.rsn),
		getWeeklyClaimAt(user.id)
	]);
	if (!pack) return null; // no weekly pack configured → nothing to show
	if (!member) return null;

	const claimed = claimedThisWeek(claimAt);
	return {
		id: 'weekly-pack',
		kind: 'packs',
		status: claimed ? 'done' : 'todo',
		title: 'Weekly free pack',
		description: claimed ? 'Claimed this week' : `Claim your free ${pack.name}`,
		// Claimed on the gamba store (like the daily crate); this is just the nudge/link.
		href: '/gamba',
		ctaLabel: claimed ? 'Go to packs' : 'Claim pack',
		resetAt: nextWeeklyResetIso(),
		reward: pack.name
	};
}

// --- Weekly/daily tasks (vs_events instances; submitted on-site) ------------
// One card per active task instance, carrying this player's submission status.
// A player's submissions are matched by site account (user_id) OR Discord id
// (the bot writes Discord submissions with discord_id and no user_id).
async function taskInstanceTasks(user: SessionUser): Promise<PlayerTask[]> {
	const instances = await loadActiveTaskInstances();
	if (instances.length === 0) return [];

	const ids = instances.map((i) => i.id);
	const { data: subs } = await db()
		.from('vs_submissions')
		.select('task_id, status')
		.in('task_id', ids)
		.or(`user_id.eq.${user.id},discord_id.eq.${user.discord_id}`);

	const byEvent = new Map<string, { approved: boolean; pending: boolean }>();
	for (const s of (subs ?? []) as Array<{ task_id: string; status: string }>) {
		const e = byEvent.get(s.task_id) ?? { approved: false, pending: false };
		if (s.status === 'approved') e.approved = true;
		else if (s.status === 'pending') e.pending = true;
		byEvent.set(s.task_id, e);
	}

	return instances.map((inst) => {
		const mine = byEvent.get(inst.id) ?? { approved: false, pending: false };
		const kind: PlayerTask['kind'] = inst.kind === 'daily_task' ? 'daily' : 'weekly';
		return {
			id: `task-${inst.id}`,
			kind,
			status: mine.approved ? 'done' : 'todo',
			title: inst.name,
			description: mine.approved ? 'Completed' : mine.pending ? 'In review' : 'Submit your proof',
			href: '/tasks/weekly',
			ctaLabel: mine.approved ? 'View submission' : mine.pending ? 'Add more proof' : 'Submit proof',
			resetAt: mine.approved ? null : inst.endsAt,
			reward: inst.reward
		};
	});
}

// --- Task events (admin-created simple/sequential events; /event/[slug]) -----
// Each is a vs_events row (kind simple|sequential) whose objectives are vs_tasks
// rows (kind=event_task, event_id set). Surfaced once the event is OPEN and live
// (past its start). One card per event; progress = approved objective submissions
// / total objectives. Submissions match the site account (user_id) OR Discord id.
async function taskEventTasks(user: SessionUser): Promise<PlayerTask[]> {
	// One query for open tasks + their open parent event via an inner embed (was two
	// serial queries: events, then tasks by event id). The liveness window is applied
	// in JS on the embedded event, same as before.
	const { data: taskRows } = await db()
		.from('vs_tasks')
		.select('id, event_id, vs_events!event_id!inner(id, slug, name, status, starts_at, ends_at, kind)')
		.eq('status', 'open')
		.eq('vs_events.status', 'open')
		.in('vs_events.kind', [SIMPLE_EVENT_KIND, SEQUENTIAL_EVENT_KIND]);

	type EventEmbed = {
		id: string;
		slug: string;
		name: string;
		status: string;
		starts_at: string | null;
		ends_at: string | null;
	};
	const allTasks = ((taskRows ?? []) as unknown as Array<{
		id: string;
		event_id: string;
		vs_events: EventEmbed;
	}>);

	// Open AND within its window (skip upcoming AND already-ended ones — neither is
	// actionable now).
	const liveById = new Map<string, EventEmbed>();
	for (const t of allTasks) {
		const e = t.vs_events;
		if (e && isEventLive(e.status, e.starts_at, e.ends_at)) liveById.set(e.id, e);
	}
	const live = [...liveById.values()] as unknown as Array<Record<string, unknown>>;
	if (live.length === 0) return [];

	const tasks = allTasks
		.filter((t) => liveById.has(t.event_id))
		.map((t) => ({ id: t.id, event_id: t.event_id }));
	if (tasks.length === 0) return [];

	const taskIds = tasks.map((t) => t.id);
	const { data: subs } = await db()
		.from('vs_submissions')
		.select('task_id')
		.in('task_id', taskIds)
		.eq('status', 'approved')
		.or(`user_id.eq.${user.id},discord_id.eq.${user.discord_id}`);
	const approved = new Set((subs ?? []).map((s) => s.task_id as string));

	const total = new Map<string, number>();
	const done = new Map<string, number>();
	for (const t of tasks) {
		total.set(t.event_id, (total.get(t.event_id) ?? 0) + 1);
		if (approved.has(t.id)) done.set(t.event_id, (done.get(t.event_id) ?? 0) + 1);
	}

	return live
		.filter((e) => (total.get(e.id as string) ?? 0) > 0)
		.map((e) => {
			const id = e.id as string;
			const tot = total.get(id) ?? 0;
			const dn = done.get(id) ?? 0;
			const allDone = dn >= tot;
			return {
				id: `event-${id}`,
				kind: 'event' as const,
				status: allDone ? ('done' as const) : ('todo' as const),
				title: (e.name as string) || 'Event',
				description: `${dn}/${tot} tasks done`,
				href: `/event/${e.slug as string}`,
				ctaLabel: allDone ? 'View event' : 'Do tasks',
				resetAt: allDone ? null : ((e.ends_at as string | null) ?? null),
				timerLabel: 'Time left',
				progress: { done: dn, total: tot }
			};
		});
}

// --- Skill or Kill (bot events/type=sotw|botw) -----------------------------
// One combined card → the on-site leaderboard (/tasks/skill-or-kill), which pulls
// live WOM standings. Personal participation isn't auto-detected (lives in WOM), so
// this stays an informational 'active' card with a countdown to the soonest end.
async function skillOrKillTask(): Promise<PlayerTask | null> {
	const { data: comps } = await db()
		.from('events')
		.select('type, ends_at, place_rewards')
		.eq('status', 'active')
		.in('type', ['sotw', 'botw'])
		.order('created_at', { ascending: false });
	if (!comps || comps.length === 0) return null;

	let soonest: number | null = null;
	for (const c of comps) {
		const t = c.ends_at ? new Date(c.ends_at as string).getTime() : null;
		if (t != null && (soonest == null || t < soonest)) soonest = t;
	}
	const parts = [
		comps.some((c) => c.type === 'sotw') ? 'skill' : null,
		comps.some((c) => c.type === 'botw') ? 'boss' : null
	].filter(Boolean);

	// Reward = the top-3 VP prizes (place_rewards = [1st, 2nd, 3rd]). Use the first
	// active comp that has any positive prize; fall back to a generic label.
	let reward: string | null = null;
	for (const c of comps) {
		const pr = (c.place_rewards as number[] | null) ?? null;
		if (pr && pr.some((n) => Number(n) > 0)) {
			const [a = 0, b = 0, third = 0] = pr;
			reward = `1st ${a} · 2nd ${b} · 3rd ${third} VP`;
			break;
		}
	}
	if (!reward) reward = 'Top-3 VP prizes';

	return {
		id: 'skill-or-kill',
		kind: 'competition',
		status: 'active',
		title: 'Skill or Kill',
		description: parts.length ? `Active ${parts.join(' + ')} competition` : 'Active competition',
		href: '/tasks/skill-or-kill',
		ctaLabel: 'View leaderboard',
		resetAt: soonest != null ? new Date(soonest).toISOString() : null,
		reward
	};
}

// --- Bingo (vs_events slug=echo-rumors, only when open) --------------------
async function bingoTask(user: SessionUser): Promise<PlayerTask | null> {
	const { data: ev } = await db()
		.from('vs_events')
		.select('id, status, starts_at, signup_opens_at')
		.eq('slug', BINGO_EVENT_SLUG)
		.maybeSingle();
	if (!ev || ev.status !== 'open') return null;

	const { data: tiles } = await db()
		.from('vs_bingo_completions')
		.select('tile_id')
		.eq('event_id', ev.id)
		.eq('user_id', user.id)
		.eq('status', 'approved');

	// Distinct tiles (a player can in theory have >1 approved row for a tile).
	const done = new Set((tiles ?? []).map((r) => r.tile_id as string)).size;
	const state = getBingoState((ev.starts_at as string | null) ?? (ev.signup_opens_at as string | null));
	const rowLabel = state.activeRow != null ? ` · row ${state.activeRow + 1}/${BINGO_ROW_COUNT}` : '';

	return {
		id: 'event-bingo',
		kind: 'event',
		status: 'active',
		title: 'Echo Rumors bingo',
		description: `${done}/${BINGO_TILE_TOTAL} tiles${rowLabel}`,
		href: `/bingo/${BINGO_EVENT_SLUG}`,
		ctaLabel: 'Open board',
		resetAt: state.nextRowAt ? state.nextRowAt.toISOString() : null,
		reward: 'Leaderboard points',
		progress: { done, total: BINGO_TILE_TOTAL }
	};
}

// --- DuoWolf (lightweight: team membership + raw approved-tile count) -------
// The full 21-stage progress machine isn't implemented; surface a raw count only.
async function duoWolfTask(user: SessionUser): Promise<PlayerTask | null> {
	// Event row + the user's signup in parallel: the signup is matched to the event
	// through an inner embed on its slug instead of waiting for the event id.
	const [{ data: ev }, { data: signupRow }] = await Promise.all([
		db().from('vs_events').select('id, status').eq('slug', DUO_WOLF_SLUG).maybeSingle(),
		db()
			.from('vs_event_signups')
			.select('team_id, vs_events!event_id!inner(slug)')
			.eq('vs_events.slug', DUO_WOLF_SLUG)
			.eq('user_id', user.id)
			.maybeSingle()
	]);
	if (!ev || ev.status !== 'open') return null;

	const signup = (signupRow as { team_id: string | null } | null) ?? null;

	if (!signup || !signup.team_id) {
		return {
			id: 'event-duowolf',
			kind: 'event',
			status: 'todo',
			title: 'DuoWolf',
			description: 'Join or form a team',
			href: `/events/${DUO_WOLF_SLUG}`,
			ctaLabel: 'Go to event',
			resetAt: null
		};
	}

	const { data: rows } = await db()
		.from('vs_submissions')
		.select('target_id')
		.eq('event_id', ev.id)
		.eq('team_id', signup.team_id)
		.eq('status', 'approved');
	const done = new Set((rows ?? []).map((r) => r.target_id as string)).size;

	return {
		id: 'event-duowolf',
		kind: 'event',
		status: 'active',
		title: 'DuoWolf',
		description: `${done} tiles done`,
		href: `/events/${DUO_WOLF_SLUG}/board`,
		ctaLabel: 'Open board',
		resetAt: null,
		progress: null
	};
}

// --- Unopened card packs (vs_user_packs) -----------------------------------
// Nudge to open any packs sitting in the player's inventory (opened at /gamba).
async function unopenedPacksTask(user: SessionUser): Promise<PlayerTask | null> {
	const { data } = await db()
		.from('vs_user_packs')
		.select('quantity')
		.eq('user_id', user.id)
		.gt('quantity', 0);
	const total = ((data ?? []) as Array<{ quantity: number | null }>).reduce(
		(sum, r) => sum + (Number(r.quantity) || 0),
		0
	);
	if (total <= 0) return null;
	return {
		id: 'open-packs',
		kind: 'packs',
		status: 'todo',
		title: 'Open your packs',
		description: `You have ${total} unopened pack${total === 1 ? '' : 's'}`,
		href: '/gamba',
		ctaLabel: 'Open packs',
		resetAt: null,
		reward: 'New cards'
	};
}

// --- Admin: pending submissions awaiting review ----------------------------
// Only for admins, and only when something's actually queued. Surfaces the
// unified review backlog as a top-of-list to-do so admins don't have to poll
// /admin/submissions. Counts raw pending rows across all submission sources.
async function adminReviewTask(user: SessionUser): Promise<PlayerTask | null> {
	if (!isAdmin(user)) return null;
	const pending = await countPendingReview();
	if (pending <= 0) return null;
	return {
		id: 'admin-review',
		kind: 'admin',
		status: 'todo',
		title: 'Review submissions',
		description: `${pending} ${pending === 1 ? 'submission' : 'submissions'} awaiting review`,
		href: '/admin/submissions',
		ctaLabel: 'Review now',
		resetAt: null
	};
}

const STATUS_ORDER: Record<PlayerTask['status'], number> = { todo: 0, active: 1, done: 2 };
// admin first within a status group (review backlog is the priority for admins).
const KIND_ORDER: Record<PlayerTask['kind'], number> = {
	admin: -1,
	daily: 0,
	weekly: 1,
	event: 2,
	competition: 3,
	packs: 4
};

export async function loadPlayerTasks(user: SessionUser): Promise<PlayerTask[]> {
	const results = await Promise.all([
		adminReviewTask(user),
		dailyCrateTask(user),
		weeklyPackTask(user),
		taskInstanceTasks(user),
		taskEventTasks(user),
		skillOrKillTask(),
		bingoTask(user),
		duoWolfTask(user),
		unopenedPacksTask(user)
	]);

	const tasks: PlayerTask[] = [];
	for (const r of results) {
		if (!r) continue;
		if (Array.isArray(r)) tasks.push(...r);
		else tasks.push(r);
	}

	// Actionable first (todo → active → done); stable kind order within a group.
	tasks.sort(
		(a, b) =>
			STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || KIND_ORDER[a.kind] - KIND_ORDER[b.kind]
	);
	return tasks;
}

// Count of outstanding to-dos for the "To Do" nav badge (see isOutstandingTask).
// Best-effort: never throws, so a DB hiccup just hides the badge instead of
// breaking the nav on every page (this runs in the root layout load).
export async function loadTodoBadgeCount(user: SessionUser): Promise<number> {
	try {
		return countOutstandingTasks(await loadPlayerTasks(user));
	} catch {
		return 0;
	}
}
