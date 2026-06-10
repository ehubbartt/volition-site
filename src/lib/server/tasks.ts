import { db } from './db';
import type { SessionUser } from './auth';
import { getLastLootDate } from './playerStats';
import { BINGO_TILES } from './bingoTiles';
import { getBingoState } from '$lib/bingo/state';
import { BINGO_EVENT_SLUG, BINGO_ROW_COUNT } from '$lib/bingo/config';
import { type PlayerTask, nextUtcMidnightIso } from '$lib/tasks';

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
		resetAt: done ? nextUtcMidnightIso() : null,
		reward: 'VP + item drops'
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
	const { data: ev } = await db()
		.from('vs_events')
		.select('id, status')
		.eq('slug', DUO_WOLF_SLUG)
		.maybeSingle();
	if (!ev || ev.status !== 'open') return null;

	const { data: signup } = await db()
		.from('vs_event_signups')
		.select('team_id')
		.eq('event_id', ev.id)
		.eq('user_id', user.id)
		.maybeSingle();

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
		.from('vs_team_completions')
		.select('tile_id')
		.eq('event_id', ev.id)
		.eq('team_id', signup.team_id)
		.eq('status', 'approved');
	const done = new Set((rows ?? []).map((r) => r.tile_id as string)).size;

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

const STATUS_ORDER: Record<PlayerTask['status'], number> = { todo: 0, active: 1, done: 2 };
const KIND_ORDER: Record<PlayerTask['kind'], number> = { daily: 0, weekly: 1, event: 2, competition: 3 };

export async function loadPlayerTasks(user: SessionUser): Promise<PlayerTask[]> {
	const results = await Promise.all([
		dailyCrateTask(user),
		taskInstanceTasks(user),
		skillOrKillTask(),
		bingoTask(user),
		duoWolfTask(user)
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
