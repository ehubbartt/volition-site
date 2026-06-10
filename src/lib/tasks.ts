// CLIENT-SAFE: the PlayerTask type + the reset/format time helpers shared by the
// /tasks page and the home summary card. No server imports — the aggregation that
// reads the DB lives in $lib/server/tasks.ts.

export type TaskKind = 'daily' | 'weekly' | 'event' | 'competition';
export type TaskStatus = 'todo' | 'done' | 'active';

export interface PlayerTask {
	// Stable key, e.g. 'daily-crate', 'weekly-mission', 'event-bingo', `competition-${id}`.
	id: string;
	kind: TaskKind;
	status: TaskStatus;
	title: string;
	// Sub-line: a hint ("Open your free crate"), the mission title, or progress text.
	description: string | null;
	// Deep link to where the player does the thing (internal route or external url).
	href: string;
	ctaLabel: string;
	// ISO timestamp the countdown ticks toward, or null (no timer — actionable now).
	resetAt: string | null;
	// What completing it awards, shown as a chip (e.g. "5 VP", "White Pack",
	// "VP + item drops"). null = no fixed/known reward to advertise.
	reward?: string | null;
	// true → render the link as target=_blank rel=noopener (Discord/WOM).
	external?: boolean;
	progress?: { done: number; total: number } | null;
}

// --- Time helpers (single source of truth for the tasks UI) ---------------

// ms from `fromMs` to the next 00:00 UTC — the daily crate reset, matching the
// bot's last_loot_date day boundary (mirrors the gamba page's helper).
export function msUntilNextUtcMidnight(fromMs: number): number {
	const d = new Date(fromMs);
	return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1) - fromMs;
}

// ISO of the next 00:00 UTC — set server-side as the daily crate's resetAt.
export function nextUtcMidnightIso(fromMs: number = Date.now()): string {
	return new Date(fromMs + msUntilNextUtcMidnight(fromMs)).toISOString();
}

// ms to the next Monday 00:00 UTC — the weekly mission reset (the bot posts a new
// task Monday). getUTCDay(): Sun=0 … Sat=6.
export function msUntilNextWeeklyResetUtc(fromMs: number): number {
	const d = new Date(fromMs);
	const dow = d.getUTCDay();
	const daysUntilMon = (8 - dow) % 7 || 7; // always 1..7 (strictly future)
	return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + daysUntilMon) - fromMs;
}

// ISO of the next Monday 00:00 UTC — set server-side as the weekly mission resetAt.
export function nextWeeklyResetIso(fromMs: number = Date.now()): string {
	return new Date(fromMs + msUntilNextWeeklyResetUtc(fromMs)).toISOString();
}

// The tasks-UI countdown formatter. Kept separate from the gamba/bingo/home ones
// (different formats) so this stays additive and doesn't regress those views.
export function formatCountdown(ms: number | null | undefined): string {
	if (ms == null || ms <= 0) return 'soon';
	const total = Math.floor(ms / 1000);
	const d = Math.floor(total / 86400);
	const h = Math.floor((total % 86400) / 3600);
	const m = Math.floor((total % 3600) / 60);
	const s = total % 60;
	const pad = (n: number) => String(n).padStart(2, '0');
	if (d > 0) return `${d}d ${h}h ${pad(m)}m`;
	if (h > 0) return `${h}h ${pad(m)}m`;
	if (m > 0) return `${m}m ${pad(s)}s`;
	return `${pad(s)}s`;
}
