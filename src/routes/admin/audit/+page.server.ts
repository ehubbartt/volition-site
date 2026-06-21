import { redirect, error } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { isAdmin } from '$lib/server/auth';
import { enrichAuditRows, type AuditEnrichment } from '$lib/server/audit';
import type { PageServerLoad } from './$types';

// How many recent rows to load per page. Filtering happens client-side over this set;
// "Load older" walks back via the ?before cursor.
const PAGE_SIZE = 500;

export interface AuditRow {
	id: string;
	created_at: string;
	actor_user_id: string | null;
	actor_discord_id: string | null;
	actor_name: string | null;
	is_admin: boolean;
	is_card_tester: boolean;
	method: string | null;
	route_id: string | null;
	path: string | null;
	action: string | null;
	status: number | null;
	payload: unknown;
	ip: string | null;
	user_agent: string | null;
}

export type EnrichedAuditRow = AuditRow & AuditEnrichment;

// Admin-only (the audit log is sensitive — card testers don't see it).
export const load: PageServerLoad = async ({ locals, url }) => {
	if (!locals.user) throw redirect(303, '/');
	if (!isAdmin(locals.user)) throw error(403, 'Not allowed');

	// Cursor for "load older": fetch rows strictly before this created_at.
	const before = url.searchParams.get('before');

	let q = db()
		.from('vs_audit_log')
		.select(
			'id, created_at, actor_user_id, actor_discord_id, actor_name, is_admin, is_card_tester, method, route_id, path, action, status, payload, ip, user_agent'
		)
		.order('created_at', { ascending: false })
		.limit(PAGE_SIZE);
	if (before) q = q.lt('created_at', before);

	const { data, error: qErr } = await q;
	if (qErr) throw error(500, qErr.message);

	const baseRows = (data ?? []) as AuditRow[];

	// Smart-parse the catch-all payloads: resolve ids → names + build a human summary and a
	// before→after diff for DB edits (read-side only; doesn't change what's stored).
	// `userNames` (userId → RSN) lets the viewer print every user id as the person's RSN.
	const { byRow, userNames } = await enrichAuditRows(baseRows);
	const rows: EnrichedAuditRow[] = baseRows.map((r) => ({
		...r,
		...(byRow.get(r.id) ?? { summary: null, changes: null, resolved: [] })
	}));

	// Distinct actors + routes present in this page, for the filter chips/dropdowns.
	const actorSet = new Map<string, string>(); // discord_id|name -> label
	const routeSet = new Set<string>();
	for (const r of rows) {
		const label = r.actor_name ?? r.actor_discord_id ?? 'anonymous';
		actorSet.set(r.actor_discord_id ?? label, label);
		if (r.route_id) routeSet.add(r.route_id);
	}

	const actors = [...actorSet.entries()]
		.map(([id, label]) => ({ id, label }))
		.sort((a, b) => a.label.localeCompare(b.label));
	const routes = [...routeSet].sort();

	return {
		rows,
		userNames,
		actors,
		routes,
		pageSize: PAGE_SIZE,
		hasMore: rows.length === PAGE_SIZE,
		nextBefore: rows.length ? rows[rows.length - 1].created_at : null
	};
};
