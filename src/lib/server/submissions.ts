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

import { db } from './db';
import { renderMarkdown } from '$lib/markdown';
import { CLAN_LABEL } from '$lib/clans';
import { BINGO_BUCKET, MAX_UPLOAD_BYTES, MAX_IMAGES_PER_SUBMISSION, ALLOWED_MIME } from '$lib/bingo/config';
import { BINGO_TILE_BY_ID, getTileDetails } from '$lib/server/bingoTiles';
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
	return { id: targetId, label: targetLabel?.trim() || targetId, detail_html: null };
}

// Cheap headcount of pending rows across all three sources — for the admin to-do
// surface (no embeds, no grouping; just three count queries). Returns total rows.
export async function countPendingReview(): Promise<number> {
	const sb = db();
	const [bingo, team, generic] = await Promise.all([
		sb.from('vs_bingo_completions').select('id', { count: 'exact', head: true }).eq('status', 'pending'),
		sb.from('vs_team_completions').select('id', { count: 'exact', head: true }).eq('status', 'pending'),
		sb.from('vs_submissions').select('id', { count: 'exact', head: true }).eq('status', 'pending')
	]);
	return (bingo.count ?? 0) + (team.count ?? 0) + (generic.count ?? 0);
}

// Loads every pending submission across all sources, normalised + grouped into one
// ReviewItem per (source, event, submitter-or-team, task). Also returns the distinct
// events present (for the queue's event filter) and headline counts.
export async function loadPendingReview(): Promise<{
	items: ReviewItem[];
	events: { id: string; slug: string; name: string }[];
	stats: { pending: number; approved: number; rejected: number };
}> {
	const sb = db();

	const [eventsRes, bingoRes, teamRes, genericRes, approvedRes, rejectedRes] = await Promise.all([
		sb.from('vs_events').select('id, slug, name'),
		sb
			.from('vs_bingo_completions')
			.select(
				'id, event_id, user_id, tile_id, proof_urls, submitted_at, vs_users!user_id(id, rsn, discord_username, account_type, clan_allegiance)'
			)
			.eq('status', 'pending')
			.order('submitted_at', { ascending: true }),
		sb
			.from('vs_team_completions')
			.select(
				'id, event_id, user_id, team_id, tile_id, proof_urls, submitted_at, vs_users!user_id(id, rsn, discord_username, account_type, clan_allegiance), vs_teams!team_id(id, name)'
			)
			.eq('status', 'pending')
			.order('submitted_at', { ascending: true }),
		sb
			.from('vs_submissions')
			.select(
				'id, event_id, task_id, user_id, discord_id, submitter_name, team_id, target_id, target_label, proof_urls, submitted_at, vs_users!user_id(id, rsn, discord_username, account_type, clan_allegiance), vs_teams!team_id(id, name), vs_tasks!task_id(id, name)'
			)
			.eq('status', 'pending')
			.order('submitted_at', { ascending: true }),
		sb.from('vs_submissions').select('id', { count: 'exact', head: true }).eq('status', 'approved'),
		sb.from('vs_submissions').select('id', { count: 'exact', head: true }).eq('status', 'rejected')
	]);

	const eventById = new Map<string, { id: string; slug: string; name: string }>(
		(eventsRes.data ?? []).map((e) => [e.id, { id: e.id, slug: e.slug, name: e.name }])
	);

	const raw: RawRow[] = [];

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
			proof_urls: (r.proof_urls as string[] | null) ?? [],
			submitted_at: r.submitted_at as string,
			user: r.vs_users
		});
	}

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
		const owner = r.team_id ?? r.user_id ?? r.discord_id ?? r.submitter_name ?? r.id;
		const key = `${r.source}|${context.id}|${owner}|${r.target_id}`;

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
				count: 0
			};
			groups.set(key, group);
		}
		group.ids.push(r.id);
		group.proofUrls.push(...(r.proof_urls ?? []));
		group.count += 1;
		if (r.submitted_at < group.submittedAt) group.submittedAt = r.submitted_at;
	}

	const items = Array.from(groups.values()).sort((a, b) => a.submittedAt.localeCompare(b.submittedAt));

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
export async function loadReviewedSubmissions(limitPerSource = 200): Promise<{
	items: ReviewedItem[];
	events: { id: string; slug: string; name: string }[];
}> {
	const sb = db();
	const REVIEWED = ['approved', 'rejected'];

	const [eventsRes, bingoRes, teamRes, genericRes] = await Promise.all([
		sb.from('vs_events').select('id, slug, name'),
		sb
			.from('vs_bingo_completions')
			.select(
				'id, event_id, user_id, tile_id, proof_urls, submitted_at, status, reviewed_at, review_note, vs_users!user_id(id, rsn, discord_username, account_type, clan_allegiance), reviewer:vs_users!reviewed_by(rsn, discord_username)'
			)
			.in('status', REVIEWED)
			.order('reviewed_at', { ascending: false })
			.limit(limitPerSource),
		sb
			.from('vs_team_completions')
			.select(
				'id, event_id, user_id, team_id, tile_id, proof_urls, submitted_at, status, reviewed_at, review_note, vs_users!user_id(id, rsn, discord_username, account_type, clan_allegiance), vs_teams!team_id(id, name), reviewer:vs_users!reviewed_by(rsn, discord_username)'
			)
			.in('status', REVIEWED)
			.order('reviewed_at', { ascending: false })
			.limit(limitPerSource),
		sb
			.from('vs_submissions')
			.select(
				'id, event_id, task_id, user_id, discord_id, submitter_name, team_id, target_id, target_label, proof_urls, submitted_at, status, reviewed_at, review_note, vs_users!user_id(id, rsn, discord_username, account_type, clan_allegiance), vs_teams!team_id(id, name), vs_tasks!task_id(id, name), reviewer:vs_users!reviewed_by(rsn, discord_username)'
			)
			.in('status', REVIEWED)
			.order('reviewed_at', { ascending: false })
			.limit(limitPerSource)
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
			proof_urls: (r.proof_urls as string[] | null) ?? [],
			submitted_at: r.submitted_at as string,
			user: r.vs_users,
			status: r.status as 'approved' | 'rejected',
			reviewed_at: (r.reviewed_at as string | null) ?? null,
			review_note: (r.review_note as string | null) ?? null,
			reviewer: reviewerName(r.reviewer)
		});
	}

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
			proof_urls: (r.proof_urls as string[] | null) ?? [],
			submitted_at: r.submitted_at as string,
			user: r.vs_users,
			status: r.status as 'approved' | 'rejected',
			reviewed_at: (r.reviewed_at as string | null) ?? null,
			review_note: (r.review_note as string | null) ?? null,
			reviewer: reviewerName(r.reviewer)
		});
	}

	// Group by (source, context, owner, target, STATUS) — status is in the key so a
	// group is homogeneous (a mixed-decision tile splits into two cards).
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
		const owner = r.team_id ?? r.user_id ?? r.discord_id ?? r.submitter_name ?? r.id;
		const key = `${r.source}|${context.id}|${owner}|${r.target_id}|${r.status}`;

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
		events: Array.from(presentEvents.values()).sort((a, b) => a.name.localeCompare(b.name))
	};
}

// Applies a decision to a group of rows in the right source table. Only flips rows
// still 'pending', so a double-click or stale queue can't clobber a prior review.
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
}): Promise<{ error?: string }> {
	const table = SOURCE_TABLE[source];
	if (!table) return { error: 'Unknown submission source' };
	if (ids.length === 0) return { error: 'No submissions to update' };

	const { error } = await db()
		.from(table)
		.update({
			status: decision === 'approve' ? 'approved' : 'rejected',
			reviewed_at: new Date().toISOString(),
			reviewed_by: reviewerId,
			review_note: note
		})
		.in('id', ids)
		.eq('status', 'pending');

	return error ? { error: error.message } : {};
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
	files: File[];
}): Promise<{ ok: true } | { ok: false; error: string }> {
	if (!taskId && !eventId) return { ok: false, error: 'Missing task/event' };

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
		proof_urls: urls,
		proof_paths: paths
	});
	if (insErr) {
		await db().storage.from(BINGO_BUCKET).remove(paths);
		return { ok: false, error: insErr.message };
	}

	return { ok: true };
}
