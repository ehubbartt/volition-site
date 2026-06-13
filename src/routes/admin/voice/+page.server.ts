import { redirect, error } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { isAdmin } from '$lib/server/auth';
import type { PageServerLoad } from './$types';

// Voice activity panel (migrated from volition-admin-dashboard). Reads the bot's voice
// tracking tables: per-user totals, daily aggregates, and the live activity log.

export type VoiceUser = { user_id: string; name: string; total_minutes: number; total_ticks: number };
export type VoiceDay = { date: string; total_minutes: number; unique_users: number; peak_concurrent: number };
export type VoiceActivity = { id: string | number; name: string; created_at: string; type: string | null };

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) throw redirect(303, '/');
	if (!isAdmin(locals.user)) throw error(403, 'Not allowed');

	const todayStart = new Date();
	todayStart.setHours(0, 0, 0, 0);
	const today = new Date().toISOString().split('T')[0];
	const since30 = new Date(Date.now() - 30 * 86_400_000).toISOString().split('T')[0];

	const [{ data: players }, { data: userStats }, { data: daily }, { data: todayActive }, { data: recent }] =
		await Promise.all([
			db().from('players').select('discord_id, rsn'),
			db().from('voice_user_stats').select('user_id, total_minutes, total_ticks, username'),
			db()
				.from('voice_daily_metrics')
				.select('date, total_minutes, total_ticks, unique_users, peak_concurrent')
				.gte('date', since30)
				.order('date', { ascending: true }),
			db().from('voice_activity_log').select('user_id').gte('created_at', todayStart.toISOString()),
			db()
				.from('voice_activity_log')
				.select('*')
				.order('created_at', { ascending: false })
				.limit(50)
		]);

	const rsnByDiscord = new Map<string, string>();
	for (const p of players ?? []) {
		const row = p as { discord_id: string | null; rsn: string | null };
		if (row.discord_id && row.rsn) rsnByDiscord.set(String(row.discord_id), row.rsn);
	}

	const users: VoiceUser[] = (userStats ?? [])
		.map((u) => {
			const row = u as { user_id: string; total_minutes: number | null; total_ticks: number | null; username: string | null };
			return {
				user_id: String(row.user_id),
				name: rsnByDiscord.get(String(row.user_id)) || row.username || String(row.user_id),
				total_minutes: row.total_minutes ?? 0,
				total_ticks: row.total_ticks ?? 0
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
		const row = a as { id: string | number; user_id: string; username?: string | null; created_at: string; type?: string | null };
		return {
			id: row.id,
			name: rsnByDiscord.get(String(row.user_id)) || row.username || String(row.user_id),
			created_at: row.created_at,
			type: row.type ?? null
		};
	});

	const stats = {
		totalMinutes: users.reduce((s, u) => s + u.total_minutes, 0),
		totalUsers: users.length,
		activeToday: new Set((todayActive ?? []).map((r) => String((r as { user_id: string }).user_id))).size,
		peakConcurrentToday: todayRow?.peak_concurrent ?? 0
	};

	return { stats, days, users, recentActivity };
};
