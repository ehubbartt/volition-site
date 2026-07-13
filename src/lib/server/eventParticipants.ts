import { db, fetchAllFiltered } from './db';

// Resolves the set of site users (vs_users.id) who "participated" in an event — i.e.
// had at least one APPROVED tile/task completion attributed to it. Sign-ups are NOT
// required as a separate filter: submitting a completion already implies a sign-up.
// Team-based completions credit the WHOLE team (every member signed up on a team that
// completed a tile), so a teammate who didn't personally submit still counts.
//
// Completion sources, all filtered to status='approved':
//   • vs_bingo_completions  (solo bingo)                 → user_id
//   • vs_team_completions   (legacy team bingo)          → user_id + team_id
//   • vs_submissions (event-scoped, e.g. DuoWolf board)  → user_id / discord_id / team_id
//   • vs_submissions (this event's vs_tasks objectives)  → user_id / discord_id
//
// Discord-only rows (bot submissions with no linked site account) are resolved to a
// vs_users.id where one exists and dropped otherwise — they can't receive a pack, which
// FKs vs_users. Returns distinct vs_users.id values.
export async function getEventParticipantIds(eventId: string): Promise<string[]> {
	const sb = db();

	// Task events store objectives in vs_tasks (event_id set); their submissions link by
	// task_id, not event_id, so fetch the ids to sweep those completions in too.
	const { data: taskRows } = await sb.from('vs_tasks').select('id').eq('event_id', eventId);
	const taskIds = (taskRows ?? []).map((t) => (t as { id: string }).id);

	const [bingoRes, teamRes, genericEventRes, genericTaskRes] = await Promise.all([
		fetchAllFiltered((f, t) =>
			sb
				.from('vs_bingo_completions')
				.select('user_id')
				.eq('event_id', eventId)
				.eq('status', 'approved')
				.range(f, t)
		),
		fetchAllFiltered((f, t) =>
			sb
				.from('vs_team_completions')
				.select('user_id, team_id')
				.eq('event_id', eventId)
				.eq('status', 'approved')
				.range(f, t)
		),
		fetchAllFiltered((f, t) =>
			sb
				.from('vs_submissions')
				.select('user_id, discord_id, team_id')
				.eq('event_id', eventId)
				.eq('status', 'approved')
				.eq('test', false)
				.range(f, t)
		),
		taskIds.length
			? fetchAllFiltered((f, t) =>
					sb
						.from('vs_submissions')
						.select('user_id, discord_id')
						.in('task_id', taskIds)
						.eq('status', 'approved')
						.eq('test', false)
						.range(f, t)
				)
			: Promise.resolve({ data: [] as unknown[], error: null })
	]);

	const userIds = new Set<string>();
	const discordIds = new Set<string>();
	const teamIds = new Set<string>();

	for (const r of bingoRes.data as { user_id: string | null }[]) {
		if (r.user_id) userIds.add(r.user_id);
	}
	for (const r of teamRes.data as { user_id: string | null; team_id: string | null }[]) {
		if (r.user_id) userIds.add(r.user_id);
		if (r.team_id) teamIds.add(r.team_id);
	}
	for (const r of genericEventRes.data as {
		user_id: string | null;
		discord_id: string | null;
		team_id: string | null;
	}[]) {
		if (r.user_id) userIds.add(r.user_id);
		if (r.discord_id) discordIds.add(r.discord_id);
		if (r.team_id) teamIds.add(r.team_id);
	}
	for (const r of genericTaskRes.data as { user_id: string | null; discord_id: string | null }[]) {
		if (r.user_id) userIds.add(r.user_id);
		if (r.discord_id) discordIds.add(r.discord_id);
	}

	// Whole-team credit: expand each team that completed a tile to all of its signed-up
	// members (so teammates who didn't personally submit are still counted).
	if (teamIds.size) {
		const { data: memberRows } = await fetchAllFiltered((f, t) =>
			sb
				.from('vs_event_signups')
				.select('user_id')
				.eq('event_id', eventId)
				.in('team_id', [...teamIds])
				.range(f, t)
		);
		for (const r of (memberRows ?? []) as { user_id: string | null }[]) {
			if (r.user_id) userIds.add(r.user_id);
		}
	}

	// Resolve bot-only Discord submissions to site accounts; drop any without one.
	if (discordIds.size) {
		const { data: uRows } = await sb
			.from('vs_users')
			.select('id')
			.in('discord_id', [...discordIds]);
		for (const u of (uRows ?? []) as { id: string }[]) if (u.id) userIds.add(u.id);
	}

	return [...userIds];
}
