// SERVER-ONLY generic image-submission framework. One place to (a) read every
// pending proof submission across all events into a normalised ReviewItem[] for the
// unified admin queue, (b) apply an approve/reject decision to the right source
// table, and (c) let a future event create submissions + upload proofs.
//
// Three sources are aggregated (see $lib/submissions.ts):
//   generic → vs_submissions        (event-agnostic; what new events should use)
//   bingo   → vs_bingo_completions   (legacy solo bingo table)
//   team    → vs_team_completions    (legacy per-team table)
//
// Adding a future event type needs NO change here: it just writes to vs_submissions
// (via createSubmission) and its pending rows show up in /admin/submissions.

import { db, fetchAllFiltered } from './db';
import { grantPlayerVp } from './playerStats';
import { renderMarkdown } from '$lib/markdown';
import { CLAN_LABEL } from '$lib/clans';
import { BINGO_BUCKET, MAX_UPLOAD_BYTES, MAX_IMAGES_PER_SUBMISSION, ALLOWED_MIME } from '$lib/bingo/config';
import { BINGO_TILE_BY_ID, getTileDetails } from '$lib/server/bingoTiles';
import {
	DUO_TILE_IDS,
	getDuoTileName,
	getDuoTileFaq,
	getDuoTileRequired
} from '$lib/server/duoWolfTiles';
import { ensureDuoTilesFresh } from '$lib/server/duoTileStore';
import type {
	ReviewItem,
	ReviewedItem,
	ReviewDecision,
	SubmissionSource
} from '$lib/submissions';

const EXT_BY_MIME: Record<string, string> = {
	'image/png': 'png',
	'image/jpeg': 'jpg',
	'image/webp': 'webp',
	'image/gif': 'gif'
};

const SOURCE_TABLE: Record<SubmissionSource, string> = {
	generic: 'vs_submissions',
	bingo: 'vs_bingo_completions',
	team: 'vs_team_completions'
};

interface UserEmbed {
	id: string;
	rsn: string | null;
	discord_username: string;
	account_type: string | null;
	clan_allegiance: string | null;
}

interface RawRow {
	source: SubmissionSource;
	id: string;
	event_id: string | null; // bingo/team (and any future event-based generic row)
	task_id: string | null; // generic task submissions → vs_tasks
	task_name: string | null; // the task's name (label/context for task rows)
	user_id: string | null;
	discord_id: string | null;
	submitter_name: string | null;
	team_id: string | null;
	team_name: string | null;
	target_id: string;
	target_label: string | null;
	quantity: number; // count-based tiles: how many of `required` this row covers (else 1)
	proof_urls: string[] | null;
	submitted_at: string;
	user: UserEmbed | null;
}

function clanLabel(clan: string | null): string | null {
	return clan ? CLAN_LABEL[clan as keyof typeof CLAN_LABEL] ?? null : null;
}

// The display submitter for a row. Site rows have a vs_users embed; bot-originated
// generic rows have no vs_users row, so fall back to the cached submitter_name.
function buildSubmitter(r: RawRow): ReviewItem['submitter'] | null {
	if (r.user) {
		return {
			rsn: r.user.rsn,
			discord_username: r.user.discord_username,
			account_type: r.user.account_type,
			clan_label: clanLabel(r.user.clan_allegiance)
		};
	}
	if (r.source === 'generic' && (r.submitter_name || r.discord_id)) {
		const name = r.submitter_name ?? 'Discord member';
		return { rsn: name, discord_username: name, account_type: null, clan_label: null };
	}
	return null;
}

// Resolve a submission's human task label + optional how-to detail. Bingo tiles have
// server-only names/FAQ; generic rows carry their own cached label; team rows (legacy,
// currently unused) fall back to the raw target id.
function resolveTask(source: SubmissionSource, targetId: string, targetLabel: string | null) {
	if (source === 'bingo') {
		const tile = BINGO_TILE_BY_ID[targetId];
		const md = tile ? getTileDetails(tile.id) : null;
		return {
			id: targetId,
			label: tile?.name ?? targetId,
			detail_html: md ? renderMarkdown(md) : null
		};
	}
	// DuoWolf board tiles arrive as generic rows whose target_id is a board node id.
	// Surface the tile's real name + FAQ (single newlines → hard breaks, like the board).
	if (DUO_TILE_IDS.has(targetId)) {
		const faq = getDuoTileFaq(targetId);
		return {
			id: targetId,
			label: getDuoTileName(targetId) ?? targetLabel?.trim() ?? targetId,
			detail_html: faq ? renderMarkdown(faq.replace(/(?<!\n)\n(?!\n)/g, '  \n')) : null
		};
	}
	return { id: targetId, label: targetLabel?.trim() || targetId, detail_html: null };
}

// Cheap headcount of pending rows across all three sources — for the admin to-do
// surface (no embeds, no grouping; just three count queries). Returns total rows.
export async function countPendingReview(): Promise<number> {
	const sb = db();
	const [bingo, team, generic] = await Promise.all([
		sb.from('vs_bingo_completions').select('id', { count: 'exact', head: true }).eq('status', 'pending'),
		sb.from('vs_team_completions').select('id', { count: 'exact', head: true }).eq('status', 'pending'),
		sb.from('vs_submissions').select('id', { count: 'exact', head: true }).eq('status', 'pending').eq('test', false)
	]);
	return (bingo.count ?? 0) + (team.count ?? 0) + (generic.count ?? 0);
}

// Loads every pending submission across all sources, normalised + grouped into one
// ReviewItem per (source, event, submitter-or-team, task). Also returns the distinct
// events present (for the queue's event filter) and headline counts.
export async function loadPendingReview({ test = false }: { test?: boolean } = {}): Promise<{
	items: ReviewItem[];
	events: { id: string; slug: string; name: string }[];
	stats: { pending: number; approved: number; rejected: number };
}> {
	const sb = db();

	// Duo tile labels/FAQ in resolveTask() read the live tile map — keep admin edits fresh.
	await ensureDuoTilesFresh();

	const [eventsRes, bingoRes, teamRes, genericRes, approvedRes, rejectedRes] = await Promise.all([
		sb.from('vs_events').select('id, slug, name'),
		// Paginate the pending queues past the 1000-row cap (a large backlog would otherwise
		// silently drop the newest pending submissions from the review queue).
		fetchAllFiltered((f, t) =>
			sb
				.from('vs_bingo_completions')
				.select(
					'id, event_id, user_id, tile_id, proof_urls, submitted_at, vs_users!user_id(id, rsn, discord_username, account_type, clan_allegiance)'
				)
				.eq('status', 'pending')
				.order('submitted_at', { ascending: true })
				.range(f, t)
		),
		fetchAllFiltered((f, t) =>
			sb
				.from('vs_team_completions')
				.select(
					'id, event_id, user_id, team_id, tile_id, proof_urls, submitted_at, vs_users!user_id(id, rsn, discord_username, account_type, clan_allegiance), vs_teams!team_id(id, name)'
				)
				.eq('status', 'pending')
				.order('submitted_at', { ascending: true })
				.range(f, t)
		),
		fetchAllFiltered((f, t) =>
			sb
				.from('vs_submissions')
				.select(
					'id, event_id, task_id, user_id, discord_id, submitter_name, team_id, target_id, target_label, quantity, proof_urls, submitted_at, vs_users!user_id(id, rsn, discord_username, account_type, clan_allegiance), vs_teams!team_id(id, name), vs_tasks!task_id(id, name)'
				)
				.eq('status', 'pending')
				.eq('test', test)
				.order('submitted_at', { ascending: true })
				.range(f, t)
		),
		sb.from('vs_submissions').select('id', { count: 'exact', head: true }).eq('status', 'approved'),
		sb.from('vs_submissions').select('id', { count: 'exact', head: true }).eq('status', 'rejected')
	]);

	const eventById = new Map<string, { id: string; slug: string; name: string }>(
		(eventsRes.data ?? []).map((e) => [e.id, { id: e.id, slug: e.slug, name: e.name }])
	);

	const raw: RawRow[] = [];

	// bingo + team are legacy tables with no `test` column, so they only ever show in the
	// LIVE queue; the test view is generic (vs_submissions) test rows only.
	if (!test)
	for (const r of (bingoRes.data ?? []) as unknown as Array<
		Record<string, unknown> & { vs_users: UserEmbed | null }
	>) {
		raw.push({
			source: 'bingo',
			id: r.id as string,
			event_id: r.event_id as string,
			task_id: null,
			task_name: null,
			user_id: r.user_id as string,
			discord_id: null,
			submitter_name: null,
			team_id: null,
			team_name: null,
			target_id: r.tile_id as string,
			target_label: null,
			quantity: 1,
			proof_urls: (r.proof_urls as string[] | null) ?? [],
			submitted_at: r.submitted_at as string,
			user: r.vs_users
		});
	}

	if (!test)
	for (const r of (teamRes.data ?? []) as unknown as Array<
		Record<string, unknown> & { vs_users: UserEmbed | null; vs_teams: { id: string; name: string | null } | null }
	>) {
		raw.push({
			source: 'team',
			id: r.id as string,
			event_id: r.event_id as string,
			task_id: null,
			task_name: null,
			user_id: r.user_id as string,
			discord_id: null,
			submitter_name: null,
			team_id: (r.team_id as string | null) ?? null,
			team_name: r.vs_teams?.name ?? null,
			target_id: r.tile_id as string,
			target_label: null,
			quantity: 1,
			proof_urls: (r.proof_urls as string[] | null) ?? [],
			submitted_at: r.submitted_at as string,
			user: r.vs_users
		});
	}

	for (const r of (genericRes.data ?? []) as unknown as Array<
		Record<string, unknown> & {
			vs_users: UserEmbed | null;
			vs_teams: { id: string; name: string | null } | null;
			vs_tasks: { id: string; name: string | null } | null;
		}
	>) {
		raw.push({
			source: 'generic',
			id: r.id as string,
			event_id: (r.event_id as string | null) ?? null,
			task_id: (r.task_id as string | null) ?? null,
			task_name: r.vs_tasks?.name ?? null,
			user_id: (r.user_id as string | null) ?? null,
			discord_id: (r.discord_id as string | null) ?? null,
			submitter_name: (r.submitter_name as string | null) ?? null,
			team_id: (r.team_id as string | null) ?? null,
			team_name: r.vs_teams?.name ?? null,
			target_id: r.target_id as string,
			target_label: (r.target_label as string | null) ?? null,
			quantity: Math.max(1, Number(r.quantity) || 1),
			submitted_at: r.submitted_at as string,
			proof_urls: (r.proof_urls as string[] | null) ?? [],
			user: r.vs_users
		});
	}

	// Group by (source, context, owner, task). Context = the parent vs_tasks row for
	// task submissions, else the parent vs_events row. Owner = team, else user.
	const groups = new Map<string, ReviewItem>();
	for (const r of raw) {
		const context =
			r.source === 'generic' && r.task_id
				? { id: r.task_id, slug: '', name: r.task_name ?? 'Task' }
				: r.event_id
					? eventById.get(r.event_id)
					: undefined;
		if (!context) continue;
		const submitter = buildSubmitter(r);
		if (!submitter) continue;
		// One card PER SUBMISSION ROW (each submit action) — separate submits to the same
		// tile are reviewed independently (e.g. each proof covering part of a count-based
		// tile's required total approved/rejected on its own).
		const key = r.id;

		// Task rows take their label from the task name; others from resolveTask.
		const taskLabel =
			r.source === 'generic' && r.task_id
				? { id: r.target_id, label: r.task_name ?? r.target_label ?? 'Task', detail_html: null }
				: resolveTask(r.source, r.target_id, r.target_label);

		// Task submissions are generic rows linked to a vs_tasks row; everything else
		// (bingo, team, event-scoped generic) is an event submission → needs the checklist.
		const isTask = r.source === 'generic' && !!r.task_id;

		let group = groups.get(key);
		if (!group) {
			group = {
				source: r.source,
				kind: isTask ? 'task' : 'event',
				ids: [],
				event: context,
				submitter,
				team: r.team_id ? { id: r.team_id, name: r.team_name } : null,
				task: taskLabel,
				proofUrls: [],
				submittedAt: r.submitted_at,
				count: 0,
				quantity: 0,
				required: DUO_TILE_IDS.has(r.target_id) ? getDuoTileRequired(r.target_id) : null,
				approvedSoFar: null
			};
			groups.set(key, group);
		}
		group.ids.push(r.id);
		group.proofUrls.push(...(r.proof_urls ?? []));
		group.count += 1;
		group.quantity += r.quantity;
		if (r.submitted_at < group.submittedAt) group.submittedAt = r.submitted_at;
	}

	const items = Array.from(groups.values()).sort((a, b) => a.submittedAt.localeCompare(b.submittedAt));

	// Count-based team tiles (DuoWolf): fill approvedSoFar = how many of `required` the
	// team already has APPROVED, so the reviewer sees current X / required on the card.
	const countItems = items.filter((it) => it.required != null && it.team);
	if (countItems.length > 0) {
		const eventIds = [...new Set(countItems.map((it) => it.event.id))];
		const { data: approvedRows } = await db()
			.from('vs_submissions')
			.select('event_id, team_id, target_id, quantity')
			.in('event_id', eventIds)
			.eq('status', 'approved');
		const approvedByKey = new Map<string, number>();
		for (const r of (approvedRows ?? []) as Array<{
			event_id: string;
			team_id: string | null;
			target_id: string;
			quantity: number | null;
		}>) {
			const k = `${r.event_id}|${r.team_id}|${r.target_id}`;
			approvedByKey.set(k, (approvedByKey.get(k) ?? 0) + Math.max(1, Number(r.quantity) || 1));
		}
		for (const it of countItems) {
			it.approvedSoFar = approvedByKey.get(`${it.event.id}|${it.team!.id}|${it.task.id}`) ?? 0;
		}
	}

	// Distinct events present in the queue, for the filter dropdown.
	const presentEvents = new Map<string, { id: string; slug: string; name: string }>();
	for (const it of items) presentEvents.set(it.event.id, it.event);

	return {
		items,
		events: Array.from(presentEvents.values()).sort((a, b) => a.name.localeCompare(b.name)),
		stats: {
			pending: items.length,
			approved: approvedRes.count ?? 0,
			rejected: rejectedRes.count ?? 0
		}
	};
}

// Loads already-reviewed (approved/rejected) submissions across all three sources for
// the read-only history view, normalised + grouped the same way as the pending queue
// (plus status / reviewer / reviewed-at / note). Bounded per source (newest reviewed
// first) so the payload stays reasonable. Also returns the distinct events present.
export async function loadReviewedSubmissions({
	test = false,
	limitPerSource = 200,
	search = ''
}: { test?: boolean; limitPerSource?: number; search?: string } = {}): Promise<{
	items: ReviewedItem[];
	events: { id: string; slug: string; name: string }[];
	searched: boolean;
}> {
	const sb = db();
	const REVIEWED = ['approved', 'rejected'];

	// Duo tile labels in resolveTask() read the live tile map — keep admin edits fresh.
	await ensureDuoTilesFresh();

	// SERVER-SIDE SEARCH: with a term, match reviewed rows across ALL history (not just the
	// recent window) by submitter (rsn/discord), team name, event name, and the generic
	// target_label/submitter_name. Strip chars that would break PostgREST's or() syntax.
	const term = (search ?? '').replace(/[,()*%]/g, ' ').trim();
	const searching = term.length > 0;
	const limit = searching ? 500 : limitPerSource;

	let userIds: string[] = [];
	let teamIds: string[] = [];
	let eventIds: string[] = [];
	if (searching) {
		// Cap each resolved id list: it's spliced into an or() IN(...) clause, and a huge list
		// would blow the request URL size. A "find this player/team" search matches few anyway.
		const [u, t, e] = await Promise.all([
			sb.from('vs_users').select('id').or(`rsn.ilike.*${term}*,discord_username.ilike.*${term}*`).limit(100),
			sb.from('vs_teams').select('id').ilike('name', `%${term}%`).limit(100),
			sb.from('vs_events').select('id').or(`name.ilike.*${term}*,slug.ilike.*${term}*`).limit(100)
		]);
		userIds = (u.data ?? []).map((r) => (r as { id: string }).id);
		teamIds = (t.data ?? []).map((r) => (r as { id: string }).id);
		eventIds = (e.data ?? []).map((r) => (r as { id: string }).id);
	}

	// Per-source or() from the resolved ids + columns; null ⇒ this source can't match → skip.
	const orFilter = (opts: { team: boolean; generic: boolean }): string | null => {
		const c: string[] = [];
		if (userIds.length) c.push(`user_id.in.(${userIds.join(',')})`);
		if (opts.team && teamIds.length) c.push(`team_id.in.(${teamIds.join(',')})`);
		if (eventIds.length) c.push(`event_id.in.(${eventIds.join(',')})`);
		if (opts.generic) {
			c.push(`target_label.ilike.*${term}*`);
			c.push(`submitter_name.ilike.*${term}*`);
		}
		return c.length ? c.join(',') : null;
	};
	const genericOr = searching ? orFilter({ team: true, generic: true }) : null;
	const bingoOr = searching ? orFilter({ team: false, generic: false }) : null;
	const teamOr = searching ? orFilter({ team: true, generic: false }) : null;

	const empty = Promise.resolve({ data: [] as unknown[], error: null });

	let bingoQ = sb
		.from('vs_bingo_completions')
		.select(
			'id, event_id, user_id, tile_id, proof_urls, submitted_at, status, reviewed_at, review_note, vs_users!user_id(id, rsn, discord_username, account_type, clan_allegiance), reviewer:vs_users!reviewed_by(rsn, discord_username)'
		)
		.in('status', REVIEWED);
	if (bingoOr) bingoQ = bingoQ.or(bingoOr);

	let teamQ = sb
		.from('vs_team_completions')
		.select(
			'id, event_id, user_id, team_id, tile_id, proof_urls, submitted_at, status, reviewed_at, review_note, vs_users!user_id(id, rsn, discord_username, account_type, clan_allegiance), vs_teams!team_id(id, name), reviewer:vs_users!reviewed_by(rsn, discord_username)'
		)
		.in('status', REVIEWED);
	if (teamOr) teamQ = teamQ.or(teamOr);

	let genericQ = sb
		.from('vs_submissions')
		.select(
			'id, event_id, task_id, user_id, discord_id, submitter_name, team_id, target_id, target_label, quantity, proof_urls, submitted_at, status, reviewed_at, review_note, vs_users!user_id(id, rsn, discord_username, account_type, clan_allegiance), vs_teams!team_id(id, name), vs_tasks!task_id(id, name), reviewer:vs_users!reviewed_by(rsn, discord_username)'
		)
		.in('status', REVIEWED)
		.eq('test', test);
	if (genericOr) genericQ = genericQ.or(genericOr);

	const [eventsRes, bingoRes, teamRes, genericRes] = await Promise.all([
		sb.from('vs_events').select('id, slug, name'),
		// bingo + team are legacy (no `test` column) → live view only; and skip entirely when
		// a search can't possibly match them.
		test || (searching && !bingoOr) ? empty : bingoQ.order('reviewed_at', { ascending: false }).limit(limit),
		test || (searching && !teamOr) ? empty : teamQ.order('reviewed_at', { ascending: false }).limit(limit),
		searching && !genericOr ? empty : genericQ.order('reviewed_at', { ascending: false }).limit(limit)
	]);

	const eventById = new Map<string, { id: string; slug: string; name: string }>(
		(eventsRes.data ?? []).map((e) => [e.id, { id: e.id, slug: e.slug, name: e.name }])
	);

	interface ReviewedRaw extends RawRow {
		status: 'approved' | 'rejected';
		reviewed_at: string | null;
		review_note: string | null;
		reviewer: string | null;
	}

	const reviewerName = (rev: { rsn?: string | null; discord_username?: string | null } | null) =>
		rev?.rsn ?? rev?.discord_username ?? null;

	const raw: ReviewedRaw[] = [];

	// bingo + team are legacy (no `test` column) → live view only; test view is generic.
	if (!test)
	for (const r of (bingoRes.data ?? []) as unknown as Array<
		Record<string, unknown> & {
			vs_users: UserEmbed | null;
			reviewer: { rsn: string | null; discord_username: string | null } | null;
		}
	>) {
		raw.push({
			source: 'bingo',
			id: r.id as string,
			event_id: r.event_id as string,
			task_id: null,
			task_name: null,
			user_id: r.user_id as string,
			discord_id: null,
			submitter_name: null,
			team_id: null,
			team_name: null,
			target_id: r.tile_id as string,
			target_label: null,
			quantity: 1,
			proof_urls: (r.proof_urls as string[] | null) ?? [],
			submitted_at: r.submitted_at as string,
			user: r.vs_users,
			status: r.status as 'approved' | 'rejected',
			reviewed_at: (r.reviewed_at as string | null) ?? null,
			review_note: (r.review_note as string | null) ?? null,
			reviewer: reviewerName(r.reviewer)
		});
	}

	if (!test)
	for (const r of (teamRes.data ?? []) as unknown as Array<
		Record<string, unknown> & {
			vs_users: UserEmbed | null;
			vs_teams: { id: string; name: string | null } | null;
			reviewer: { rsn: string | null; discord_username: string | null } | null;
		}
	>) {
		raw.push({
			source: 'team',
			id: r.id as string,
			event_id: r.event_id as string,
			task_id: null,
			task_name: null,
			user_id: r.user_id as string,
			discord_id: null,
			submitter_name: null,
			team_id: (r.team_id as string | null) ?? null,
			team_name: r.vs_teams?.name ?? null,
			target_id: r.tile_id as string,
			target_label: null,
			quantity: 1,
			proof_urls: (r.proof_urls as string[] | null) ?? [],
			submitted_at: r.submitted_at as string,
			user: r.vs_users,
			status: r.status as 'approved' | 'rejected',
			reviewed_at: (r.reviewed_at as string | null) ?? null,
			review_note: (r.review_note as string | null) ?? null,
			reviewer: reviewerName(r.reviewer)
		});
	}

	for (const r of (genericRes.data ?? []) as unknown as Array<
		Record<string, unknown> & {
			vs_users: UserEmbed | null;
			vs_teams: { id: string; name: string | null } | null;
			vs_tasks: { id: string; name: string | null } | null;
			reviewer: { rsn: string | null; discord_username: string | null } | null;
		}
	>) {
		raw.push({
			source: 'generic',
			id: r.id as string,
			event_id: (r.event_id as string | null) ?? null,
			task_id: (r.task_id as string | null) ?? null,
			task_name: r.vs_tasks?.name ?? null,
			user_id: (r.user_id as string | null) ?? null,
			discord_id: (r.discord_id as string | null) ?? null,
			submitter_name: (r.submitter_name as string | null) ?? null,
			team_id: (r.team_id as string | null) ?? null,
			team_name: r.vs_teams?.name ?? null,
			target_id: r.target_id as string,
			target_label: (r.target_label as string | null) ?? null,
			quantity: Math.max(1, Number(r.quantity) || 1),
			proof_urls: (r.proof_urls as string[] | null) ?? [],
			submitted_at: r.submitted_at as string,
			user: r.vs_users,
			status: r.status as 'approved' | 'rejected',
			reviewed_at: (r.reviewed_at as string | null) ?? null,
			review_note: (r.review_note as string | null) ?? null,
			reviewer: reviewerName(r.reviewer)
		});
	}

	// One card PER SUBMISSION ROW (matches the pending queue), so each reviewed submit
	// shows independently with its own decision.
	const groups = new Map<string, ReviewedItem>();
	for (const r of raw) {
		const context =
			r.source === 'generic' && r.task_id
				? { id: r.task_id, slug: '', name: r.task_name ?? 'Task' }
				: r.event_id
					? eventById.get(r.event_id)
					: undefined;
		if (!context) continue;
		const submitter = buildSubmitter(r);
		if (!submitter) continue;
		const key = r.id;

		const taskLabel =
			r.source === 'generic' && r.task_id
				? { id: r.target_id, label: r.task_name ?? r.target_label ?? 'Task', detail_html: null }
				: resolveTask(r.source, r.target_id, r.target_label);

		let group = groups.get(key);
		if (!group) {
			group = {
				source: r.source,
				status: r.status,
				ids: [],
				event: context,
				submitter,
				team: r.team_id ? { id: r.team_id, name: r.team_name } : null,
				task: taskLabel,
				proofUrls: [],
				submittedAt: r.submitted_at,
				reviewedAt: r.reviewed_at,
				reviewer: r.reviewer,
				reviewNote: r.review_note,
				count: 0
			};
			groups.set(key, group);
		}
		group.ids.push(r.id);
		group.proofUrls.push(...(r.proof_urls ?? []));
		group.count += 1;
		if (r.submitted_at < group.submittedAt) group.submittedAt = r.submitted_at;
		// Keep the most recent review metadata for the group.
		if (r.reviewed_at && (!group.reviewedAt || r.reviewed_at > group.reviewedAt)) {
			group.reviewedAt = r.reviewed_at;
			group.reviewer = r.reviewer;
			group.reviewNote = r.review_note;
		}
	}

	const items = Array.from(groups.values()).sort((a, b) =>
		(b.reviewedAt ?? '').localeCompare(a.reviewedAt ?? '')
	);

	const presentEvents = new Map<string, { id: string; slug: string; name: string }>();
	for (const it of items) presentEvents.set(it.event.id, it.event);

	return {
		items,
		events: Array.from(presentEvents.values()).sort((a, b) => a.name.localeCompare(b.name)),
		searched: searching
	};
}

// Applies a decision to a group of rows in the right source table.
//  - reject: only flips rows still 'pending' (the normal queue reject). To un-approve
//    an already-approved row, use revokeSubmissions (it also reverses rewards).
//  - approve: flips 'pending' OR 'rejected' rows (so an admin can re-approve something
//    that was rejected/revoked). For generic rows that re-approval also RESETS the
//    bot-side reward flags so the pack is re-granted and the player re-notified.
export async function decideSubmissions({
	source,
	ids,
	decision,
	reviewerId,
	note
}: {
	source: SubmissionSource;
	ids: string[];
	decision: ReviewDecision;
	reviewerId: string;
	note: string | null;
}): Promise<{ error?: string; changedIds?: string[] }> {
	const table = SOURCE_TABLE[source];
	if (!table) return { error: 'Unknown submission source' };
	if (ids.length === 0) return { error: 'No submissions to update' };

	const base: Record<string, unknown> = {
		status: decision === 'approve' ? 'approved' : 'rejected',
		reviewed_at: new Date().toISOString(),
		reviewed_by: reviewerId,
		review_note: note
	};
	// Re-approving a generic row clears the reward bookkeeping so the bot re-grants the
	// pack + re-sends the approval notice, and the VP grant runs again (caller).
	if (decision === 'approve' && source === 'generic') {
		base.approval_revoked = false;
		base.pack_awarded = false;
		base.approval_notified = false;
		base.rejection_notified = false;
		base.removal_notified = true; // any prior removal is already handled
	}

	// Conditional update: only flip rows in the right starting state. Combined with the
	// `.select('id')` this is the concurrency guard — if two admins approve the same row
	// at once, Postgres row-locking means only ONE update matches `status IN (...)`; the
	// other returns zero changed rows. The caller grants VP only for rows IT changed, so
	// a simultaneous double-approve can't double-award.
	let q = db().from(table).update(base).in('id', ids);
	q = decision === 'approve' ? q.in('status', ['pending', 'rejected']) : q.eq('status', 'pending');
	const { data, error } = await q.select('id');

	return error ? { error: error.message } : { changedIds: (data ?? []).map((r) => r.id as string) };
}

// Un-approve ("revoke") already-approved submissions: flip them to rejected and undo
// the rewards. For generic (task) rows this reverses the VP itself (allowing the
// balance to go negative) and flags the row so the bot reclaims the pack (if still
// unopened) and sends a single "reward removed" notice. Bingo/team rows have no
// VP/pack reward, so it just un-approves them (the leaderboard/progress recomputes).
export async function revokeSubmissions({
	source,
	ids,
	reviewerId,
	note
}: {
	source: SubmissionSource;
	ids: string[];
	reviewerId: string;
	note: string | null;
}): Promise<{ error?: string; revoked: number }> {
	const table = SOURCE_TABLE[source];
	if (!table) return { error: 'Unknown submission source', revoked: 0 };
	if (ids.length === 0) return { error: 'No submissions to update', revoked: 0 };
	const sb = db();
	const now = new Date().toISOString();

	if (source !== 'generic') {
		const { data, error } = await sb
			.from(table)
			.update({ status: 'rejected', reviewed_at: now, reviewed_by: reviewerId, review_note: note })
			.in('id', ids)
			.eq('status', 'approved')
			.select('id');
		return error ? { error: error.message, revoked: 0 } : { revoked: data?.length ?? 0 };
	}

	// Read the currently-approved generic rows first so we can reverse VP afterwards.
	const { data: rows, error: readErr } = await sb
		.from('vs_submissions')
		.select('id, task_id, user_id, discord_id, submitter_name')
		.in('id', ids)
		.eq('status', 'approved');
	if (readErr) return { error: readErr.message, revoked: 0 };
	const approved = (rows ?? []) as Array<{
		id: string;
		task_id: string | null;
		user_id: string | null;
		discord_id: string | null;
		submitter_name: string | null;
	}>;
	if (approved.length === 0) return { revoked: 0 };
	const approvedIds = approved.map((r) => r.id);

	// Flip + flag. rejection_notified=true skips the normal "rejected" notice;
	// removal_notified=false makes the bot send the "reward removed" notice + reclaim pack.
	const { error: upErr } = await sb
		.from('vs_submissions')
		.update({
			status: 'rejected',
			reviewed_at: now,
			reviewed_by: reviewerId,
			review_note: note,
			approval_revoked: true,
			rejection_notified: true,
			removal_notified: false
		})
		.in('id', approvedIds)
		.eq('status', 'approved');
	if (upErr) return { error: upErr.message, revoked: 0 };

	// Reverse VP once per (task, submitter), mirroring grantVpForApproval — only if no
	// approved row remains for that pair (so they truly lost their credit).
	const pairs = new Map<
		string,
		{ taskId: string; userId: string | null; discordId: string | null; name: string | null }
	>();
	for (const r of approved) {
		if (!r.task_id) continue;
		const ownerKey = r.user_id ?? r.discord_id ?? r.submitter_name ?? '';
		pairs.set(`${r.task_id}|${ownerKey}`, {
			taskId: r.task_id,
			userId: r.user_id,
			discordId: r.discord_id,
			name: r.submitter_name
		});
	}
	for (const p of pairs.values()) {
		let q = sb.from('vs_submissions').select('id').eq('task_id', p.taskId).eq('status', 'approved');
		q = p.userId ? q.eq('user_id', p.userId) : q.eq('discord_id', p.discordId ?? '');
		const { data: remaining } = await q.limit(1);
		if (remaining && remaining.length > 0) continue; // still has credit → keep VP

		const { data: task } = await sb.from('vs_tasks').select('vp_reward').eq('id', p.taskId).maybeSingle();
		const vp = Number((task as { vp_reward?: number } | null)?.vp_reward ?? 0);
		if (vp <= 0) continue;

		let rsn = p.name;
		if (p.userId) {
			const { data: u } = await sb.from('vs_users').select('rsn').eq('id', p.userId).maybeSingle();
			rsn = (u as { rsn?: string | null } | null)?.rsn ?? rsn;
		}
		// Negative grant = deduct; intentionally NOT clamped (balance may go negative).
		await grantPlayerVp(p.discordId, rsn, -vp);
	}

	return { revoked: approvedIds.length };
}

// --- Helpers for future events to CREATE submissions ---------------------------

function extForMime(mime: string): string | null {
	return EXT_BY_MIME[mime] ?? null;
}

async function uploadProof(
	eventId: string,
	ownerKey: string,
	targetId: string,
	file: File
): Promise<{ path: string; url: string } | { error: string }> {
	if (file.size === 0) return { error: 'File is empty' };
	if (file.size > MAX_UPLOAD_BYTES) {
		return { error: `File too large (max ${Math.round(MAX_UPLOAD_BYTES / 1_000_000)} MB)` };
	}
	if (!(ALLOWED_MIME as readonly string[]).includes(file.type)) {
		return { error: 'Unsupported image type (use PNG, JPEG, WEBP, or GIF)' };
	}
	const ext = extForMime(file.type);
	if (!ext) return { error: 'Unsupported image type' };

	const path = `${eventId}/${ownerKey}/${targetId}-${Date.now()}.${ext}`;
	const storage = db().storage.from(BINGO_BUCKET);
	const { error: upErr } = await storage.upload(path, file, { contentType: file.type, upsert: false });
	if (upErr) return { error: upErr.message };
	const { data: pub } = storage.getPublicUrl(path);
	return { path, url: pub.publicUrl };
}

// Creates one submission (status 'pending'), uploading its proof images to the
// shared bucket first. Tasks pass `taskId` (→ vs_tasks); event-based generic
// submissions pass `eventId` (→ vs_events) — exactly one. The row then surfaces
// in /admin/submissions automatically. Pass `teamId` for team-scored submissions.
export async function createSubmission({
	taskId = null,
	eventId = null,
	userId = null,
	discordId = null,
	submitterName = null,
	teamId = null,
	targetId,
	targetLabel = null,
	quantity = 1,
	test = false,
	files
}: {
	taskId?: string | null;
	eventId?: string | null;
	userId?: string | null;
	discordId?: string | null;
	submitterName?: string | null;
	teamId?: string | null;
	targetId: string;
	targetLabel?: string | null;
	// How many of a count-based tile's `required` this single proof covers (default 1).
	// Progress sums approved quantities; non-count events just leave it 1.
	quantity?: number;
	// Test submission (admin preview run) — hidden from the live /admin/submissions queue.
	test?: boolean;
	files: File[];
}): Promise<{ ok: true } | { ok: false; error: string }> {
	if (!taskId && !eventId) return { ok: false, error: 'Missing task/event' };
	const qty = Number.isFinite(quantity) ? Math.max(1, Math.floor(quantity)) : 1;

	// One-and-done: a task this submitter has already had APPROVED can't be submitted
	// again (no farming a completed task's reward). Pending duplicates are still allowed
	// (more proof before review). Scoped to this submitter via their site account and/or
	// Discord id. Task submissions only (event/team rows don't carry this rule).
	if (taskId && (userId || discordId)) {
		const ownerOr = [
			userId ? `user_id.eq.${userId}` : null,
			discordId ? `discord_id.eq.${discordId}` : null
		]
			.filter(Boolean)
			.join(',');
		const { data: doneRows } = await db()
			.from('vs_submissions')
			.select('id')
			.eq('task_id', taskId)
			.eq('status', 'approved')
			.or(ownerOr)
			.limit(1);
		if (doneRows && doneRows.length > 0) {
			return { ok: false, error: 'You have already completed this task.' };
		}
	}

	const valid = files.filter((f) => f instanceof File && f.size > 0);
	if (valid.length === 0) return { ok: false, error: 'Add at least one proof image' };
	if (valid.length > MAX_IMAGES_PER_SUBMISSION) {
		return { ok: false, error: `Max ${MAX_IMAGES_PER_SUBMISSION} images per submission` };
	}

	const parentKey = taskId ?? eventId ?? 'task';
	const ownerKey = teamId ?? userId ?? discordId ?? 'anon';
	const urls: string[] = [];
	const paths: string[] = [];
	for (const file of valid) {
		const result = await uploadProof(parentKey, ownerKey, targetId, file);
		if ('error' in result) {
			if (paths.length) await db().storage.from(BINGO_BUCKET).remove(paths);
			return { ok: false, error: result.error };
		}
		urls.push(result.url);
		paths.push(result.path);
	}

	const { error: insErr } = await db().from('vs_submissions').insert({
		task_id: taskId,
		event_id: eventId,
		user_id: userId,
		discord_id: discordId,
		submitter_name: submitterName,
		team_id: teamId,
		target_id: targetId,
		target_label: targetLabel,
		quantity: qty,
		test,
		proof_urls: urls,
		proof_paths: paths
	});
	if (insErr) {
		await db().storage.from(BINGO_BUCKET).remove(paths);
		return { ok: false, error: insErr.message };
	}

	return { ok: true };
}
