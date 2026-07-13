import { db, fetchAllFiltered } from './db';
import { microCached } from './microCache';
import { ensureWelcomePack } from './welcomePack';
import { loadPlayerTasks } from './tasks';
import type { SessionUser } from './auth';
import { RANK_ORDER, RANK_LABEL, RANK_COLOR, rankIndex } from '$lib/ranks';
import type { Directory, Member, RankBucket, Stats, TaskSummary } from '$lib/home';

// Builds the homepage's streamed data blocks. Served as JSON by /api/home so the
// page's universal load can navigate with zero server round-trips and stream each
// block in behind its skeleton.

// The Volition clan roster lives in the bot's `players` table (this bot is
// Volition's). The home page's member-facing sections (count, lookup,
// recently-joined, rank breakdown) read from it — NOT vs_users, which also holds
// other-clan members who signed in for cross-clan events.
interface PlayerRow {
	id: number;
	rsn: string;
	discord_id: string | null;
	rank: string | null;
	points: number | null;
	clan_joined_at: string | null;
	created_at: string | null;
}

interface SiteUserRow {
	discord_id: string | null;
	rsn: string | null;
}

interface EventStatusRow {
	status: string;
	ends_at: string | null;
}

function eventCounts(rows: EventStatusRow[], now: number = Date.now()) {
	// "Active" = open/locked AND not past its own end time. An event with an explicit
	// ends_at in the past is over even if an admin hasn't flipped it to 'closed' yet
	// (mirrors the /events list). bingo has no explicit ends_at, so it stays counted.
	const active = rows.filter((r) => {
		if (r.status !== 'open' && r.status !== 'locked') return false;
		if (!r.ends_at) return true;
		const end = new Date(r.ends_at).getTime();
		if (Number.isNaN(end)) return true; // unparseable end = no real end → still active
		return now <= end;
	}).length;
	return { active, total: rows.length };
}

// Mirrors users.ts rsnExactPattern normalization (OSRS treats space/underscore as
// equal), so a roster rsn can be matched against a site rsn case/spacing-insensitively.
function normRsn(rsn: string | null | undefined): string {
	return (rsn ?? '').trim().replace(/_/g, ' ').toLowerCase();
}

// Headline event/pack counters. Logged-in users' event count includes unreleased
// (draft/preview) events, matching what the events list can show them. Shared
// across users → micro-cached (15s of staleness on counters is invisible).
export async function buildStats(includeUnreleased: boolean): Promise<Stats> {
	return microCached(`home:stats:${includeUnreleased}`, 15_000, async () => {
		const sb = db();
		const statuses = includeUnreleased
			? ['draft', 'preview', 'open', 'locked', 'closed']
			: ['open', 'locked', 'closed'];
		const [eventsRes, packsRes] = await Promise.all([
			sb
				.from('vs_events')
				.select('status, ends_at')
				.neq('kind', 'personal')
				.eq('unlisted', false) // utility events (Dink self-test) don't count as real events
				.in('status', statuses),
			sb.from('vs_pack_opens').select('id', { count: 'exact', head: true })
		]);
		const { active, total } = eventCounts((eventsRes.data ?? []) as EventStatusRow[]);
		return { activeEvents: active, totalEvents: total, packsOpened: packsRes.count ?? 0 };
	});
}

// Light summary for the home "Your to-do" card (not the full task array).
export async function buildTaskSummary(user: SessionUser): Promise<TaskSummary | null> {
	const tasks = await loadPlayerTasks(user);
	if (!tasks) return null;
	return {
		todoCount: tasks.filter((t) => t.status === 'todo').length,
		total: tasks.length,
		hasActive: tasks.some((t) => t.status === 'active')
	};
}

// Logged-out variant: just the member count for the public landing's stat tile.
export async function buildPublicDirectory(): Promise<Directory> {
	const playersRes = await db().from('players').select('id', { count: 'exact', head: true });
	return { members: [], rankBreakdown: [], recentMembers: [], memberCount: playersRes.count ?? 0 };
}

// The heavy half of the homepage: the full clan roster + site-user matching, the
// rank breakdown, and the welcome-pack backstop.
export async function buildDirectory(user: {
	id: string;
	discord_id: string;
	rsn: string | null;
	welcome_pack_granted: boolean;
}): Promise<Directory> {
	// The roster + site-user tables are identical for every viewer and are the two
	// heaviest reads on the site → micro-cache them (30s; rank/VP changes surfacing
	// half a minute late is invisible). Everything derived below is per-request.
	const { playerRows, siteUsers } = await microCached('home:roster', 30_000, async () => {
		const sb = db();
		const [playersRes, siteUsersRes] = await Promise.all([
			// Paginate: the full clan roster + all site users can exceed the 1000-row cap.
			fetchAllFiltered((f, t) =>
				sb.from('players').select('id, rsn, discord_id, rank, points, clan_joined_at, created_at').range(f, t)
			),
			fetchAllFiltered((f, t) => sb.from('vs_users').select('discord_id, rsn').not('rsn', 'is', null).range(f, t))
		]);
		return {
			playerRows: (playersRes.data ?? []) as PlayerRow[],
			siteUsers: (siteUsersRes.data ?? []) as SiteUserRow[]
		};
	});

	// Which roster members have a site profile (→ /u/[rsn] is reachable). Match on
	// discord_id first, then normalized rsn.
	const siteDiscordIds = new Set(siteUsers.map((u) => u.discord_id).filter(Boolean) as string[]);
	const siteRsns = new Set(siteUsers.map((u) => normRsn(u.rsn)).filter(Boolean));
	const hasProfile = (p: PlayerRow) =>
		(p.discord_id != null && siteDiscordIds.has(p.discord_id)) || siteRsns.has(normRsn(p.rsn));

	// Welcome pack: if this member hasn't received theirs yet and is now in the
	// Volition roster (e.g. they signed up before joining, then joined), grant it.
	// Reuses the roster already loaded above, so it's a no-op (no query) once granted.
	if (!user.welcome_pack_granted) {
		const userIsMember = playerRows.some(
			(p) =>
				(p.discord_id != null && p.discord_id === user.discord_id) ||
				normRsn(p.rsn) === normRsn(user.rsn)
		);
		await ensureWelcomePack(
			{
				id: user.id,
				discord_id: user.discord_id,
				rsn: user.rsn,
				welcome_pack_granted: user.welcome_pack_granted
			},
			userIsMember
		);
	}

	const members: Member[] = playerRows
		.map((p) => ({
			rsn: p.rsn,
			rank: p.rank,
			points: p.points ?? 0,
			joinedAt: p.clan_joined_at ?? p.created_at,
			hasProfile: hasProfile(p)
		}))
		.sort((a, b) => a.rsn.localeCompare(b.rsn, undefined, { sensitivity: 'base' }));

	// Rank breakdown in ladder order; unrecognized / null ranks collapse to one
	// "Unranked" bucket appended at the end.
	const rankCounts = new Map<string, number>();
	let unranked = 0;
	for (const p of playerRows) {
		if (rankIndex(p.rank) === -1) unranked += 1;
		else rankCounts.set(p.rank as string, (rankCounts.get(p.rank as string) ?? 0) + 1);
	}
	const rankBreakdown: RankBucket[] = RANK_ORDER.filter((r) => (rankCounts.get(r) ?? 0) > 0)
		.map((r) => ({ value: r as string, label: RANK_LABEL[r], color: RANK_COLOR[r], count: rankCounts.get(r) ?? 0 }));
	if (unranked > 0) {
		rankBreakdown.push({ value: 'unranked', label: 'Unranked', color: '#9aa0a6', count: unranked });
	}

	const recentMembers = [...members]
		.filter((m) => m.joinedAt)
		.sort((a, b) => new Date(b.joinedAt!).getTime() - new Date(a.joinedAt!).getTime())
		.slice(0, 5);

	return { members, rankBreakdown, recentMembers, memberCount: playerRows.length };
}
