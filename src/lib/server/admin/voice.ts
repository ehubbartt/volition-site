import { db, fetchAllFiltered } from '$lib/server/db';

// Voice activity panel (migrated from volition-admin-dashboard). Reads the bot's voice
// tracking tables: per-user totals, daily aggregates, and the live activity log.
//
// NAMES: the bot writes a Discord snowflake + the Discord username on every tick, and
// knows nothing about RuneScape names. The panel prefers the RSN because that is what
// admins deal with elsewhere on the site — but most members' RSN and Discord name are
// nothing alike, so a row rendered ONLY as an RSN is unfindable by someone who knows the
// member from Discord. Every surface therefore carries BOTH names and searches both.

export type VoiceUser = {
	user_id: string;
	name: string;
	discord_name: string | null;
	rsn: string | null;
	total_minutes: number;
	total_ticks: number;
	last_active_at: string | null;
};
export type VoiceDay = { date: string; total_minutes: number; unique_users: number; peak_concurrent: number };
export type VoiceActivity = {
	id: string | number;
	user_id: string;
	name: string;
	discord_name: string | null;
	channel: string | null;
	minutes: number;
	created_at: string;
};

// The activity feed is a global tail, so it is only ever a sample of the newest ticks —
// a member who was not in voice in the last little while is structurally absent from it
// no matter how much time they have banked. Per-user history comes from buildVoiceUser.
const RECENT_LIMIT = 200;

/** Discord snowflakes only — this value is interpolated into a PostgREST filter. */
const isSnowflake = (id: string) => /^\d{1,20}$/.test(id);

type PlayerRow = { discord_id: string | null; rsn: string | null };
type StatsRow = {
	user_id: string;
	total_minutes: number | null;
	total_ticks: number | null;
	username: string | null;
	last_active_at?: string | null;
};

function rsnMap(players: PlayerRow[] | null): Map<string, string> {
	const byDiscord = new Map<string, string>();
	for (const p of players ?? []) {
		if (p.discord_id && p.rsn) byDiscord.set(String(p.discord_id), p.rsn);
	}
	return byDiscord;
}

export async function buildVoice() {
	const todayStart = new Date();
	todayStart.setHours(0, 0, 0, 0);
	const today = new Date().toISOString().split('T')[0];
	const since30 = new Date(Date.now() - 30 * 86_400_000).toISOString().split('T')[0];

	const [{ data: players }, { data: userStats }, { data: daily }, { data: todayActive }, { data: recent }] =
		await Promise.all([
			fetchAllFiltered<PlayerRow>((f, t) => db().from('players').select('discord_id, rsn').range(f, t)),
			fetchAllFiltered<StatsRow>((f, t) =>
				db()
					.from('voice_user_stats')
					.select('user_id, total_minutes, total_ticks, username, last_active_at')
					.range(f, t)
			),
			db()
				.from('voice_daily_metrics')
				.select('date, total_minutes, total_ticks, unique_users, peak_concurrent')
				.gte('date', since30)
				.order('date', { ascending: true }),
			fetchAllFiltered((f, t) =>
				db().from('voice_activity_log').select('user_id').gte('created_at', todayStart.toISOString()).range(f, t)
			),
			db()
				.from('voice_activity_log')
				.select('id, user_id, username, channel_name, minutes_awarded, created_at')
				.order('created_at', { ascending: false })
				.limit(RECENT_LIMIT)
		]);

	const rsnByDiscord = rsnMap(players);

	const users: VoiceUser[] = (userStats ?? [])
		.map((row) => {
			const id = String(row.user_id);
			const rsn = rsnByDiscord.get(id) ?? null;
			return {
				user_id: id,
				name: rsn || row.username || id,
				discord_name: row.username ?? null,
				rsn,
				total_minutes: row.total_minutes ?? 0,
				total_ticks: row.total_ticks ?? 0,
				last_active_at: row.last_active_at ?? null
			};
		})
		.sort((a, b) => b.total_minutes - a.total_minutes);

	// Fill all 30 days (including zero-activity days) so the chart is continuous.
	const dailyMap = new Map((daily ?? []).map((d) => [(d as { date: string }).date, d]));
	const days: VoiceDay[] = [];
	for (let i = 29; i >= 0; i--) {
		const dateStr = new Date(Date.now() - i * 86_400_000).toISOString().split('T')[0];
		const ex = dailyMap.get(dateStr) as VoiceDay | undefined;
		days.push({
			date: dateStr,
			total_minutes: ex?.total_minutes ?? 0,
			unique_users: ex?.unique_users ?? 0,
			peak_concurrent: ex?.peak_concurrent ?? 0
		});
	}

	const todayRow = dailyMap.get(today) as VoiceDay | undefined;
	const recentActivity: VoiceActivity[] = (recent ?? []).map((a) => {
		const row = a as {
			id: string | number;
			user_id: string;
			username?: string | null;
			channel_name?: string | null;
			minutes_awarded?: number | null;
			created_at: string;
		};
		const id = String(row.user_id);
		return {
			id: row.id,
			user_id: id,
			name: rsnByDiscord.get(id) || row.username || id,
			discord_name: row.username ?? null,
			channel: row.channel_name ?? null,
			minutes: row.minutes_awarded ?? 0,
			created_at: row.created_at
		};
	});

	const stats = {
		totalMinutes: users.reduce((s, u) => s + u.total_minutes, 0),
		totalUsers: users.length,
		activeToday: new Set((todayActive ?? []).map((r) => String((r as { user_id: string }).user_id))).size,
		peakConcurrentToday: todayRow?.peak_concurrent ?? 0,
		recentLimit: RECENT_LIMIT
	};

	return { stats, days, users, recentActivity };
}

export type VoiceUserDetail = {
	user: VoiceUser;
	rank: number;
	tracked: number;
	minutes30: number;
	ticks: VoiceActivity[];
	truncated: boolean;
};

const DETAIL_LIMIT = 250;

/**
 * One member's own voice history — the answer to "this person has time banked, so why is
 * there nothing for them in the activity feed?". The feed is a global tail; this is not.
 * Returns null when the snowflake has never been tracked.
 */
export async function buildVoiceUser(userId: string): Promise<VoiceUserDetail | null> {
	if (!isSnowflake(userId)) return null;
	const since30 = new Date(Date.now() - 30 * 86_400_000).toISOString();

	const { data: statsRow } = await db()
		.from('voice_user_stats')
		.select('user_id, total_minutes, total_ticks, username, last_active_at')
		.eq('user_id', userId)
		.maybeSingle();
	if (!statsRow) return null;
	const row = statsRow as StatsRow;
	const minutes = row.total_minutes ?? 0;

	const [{ data: playerRow }, { count: ahead }, { count: tracked }, { data: ticks }, { data: recent30 }] =
		await Promise.all([
			db().from('players').select('discord_id, rsn').eq('discord_id', userId).maybeSingle(),
			db()
				.from('voice_user_stats')
				.select('user_id', { count: 'exact', head: true })
				.gt('total_minutes', minutes),
			db().from('voice_user_stats').select('user_id', { count: 'exact', head: true }),
			db()
				.from('voice_activity_log')
				.select('id, user_id, username, channel_name, minutes_awarded, created_at')
				.eq('user_id', userId)
				.order('created_at', { ascending: false })
				.limit(DETAIL_LIMIT + 1),
			fetchAllFiltered<{ minutes_awarded: number | null }>((f, t) =>
				db()
					.from('voice_activity_log')
					.select('minutes_awarded')
					.eq('user_id', userId)
					.gte('created_at', since30)
					.range(f, t)
			)
		]);

	const rsn = (playerRow as PlayerRow | null)?.rsn ?? null;
	const all = (ticks ?? []) as Array<{
		id: string | number;
		user_id: string;
		username: string | null;
		channel_name: string | null;
		minutes_awarded: number | null;
		created_at: string;
	}>;
	const truncated = all.length > DETAIL_LIMIT;

	return {
		user: {
			user_id: userId,
			name: rsn || row.username || userId,
			discord_name: row.username ?? null,
			rsn,
			total_minutes: minutes,
			total_ticks: row.total_ticks ?? 0,
			last_active_at: row.last_active_at ?? null
		},
		rank: (ahead ?? 0) + 1,
		tracked: tracked ?? 0,
		minutes30: (recent30 ?? []).reduce((s, r) => s + (r.minutes_awarded ?? 0), 0),
		ticks: all.slice(0, DETAIL_LIMIT).map((t) => ({
			id: t.id,
			user_id: userId,
			name: rsn || t.username || userId,
			discord_name: t.username ?? null,
			channel: t.channel_name ?? null,
			minutes: t.minutes_awarded ?? 0,
			created_at: t.created_at
		})),
		truncated
	};
}
