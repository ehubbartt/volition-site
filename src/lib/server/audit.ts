import type { RequestEvent } from '@sveltejs/kit';
import { db } from './db';
import { isAdmin, isCardTester } from './auth';

// SERVER-ONLY automatic admin audit log. Every site mutation is a SvelteKit form
// action POST (?/actionName); hooks.server.ts calls into here to record the
// privileged ones into vs_audit_log — so there's no per-feature code and no schema
// churn (the `payload` jsonb absorbs whatever the form posted). All best-effort:
// any failure is logged and swallowed so it NEVER breaks the request being audited.

// Skip parsing (and thus buffering) bodies bigger than this — card art / .glb model
// uploads can be tens of MB and we never store their bytes anyway.
const MAX_BODY_BYTES = 30_000_000;
// Cap any single captured string so a giant textarea can't bloat a row. Generous enough
// that a typical DB-row JSON (the table editor's `payload` field) survives intact for the
// before/after diff; truly huge values still truncate (the diff just falls back to none).
const MAX_FIELD_CHARS = 8000;

// Should this request be recorded? POSTs under /admin/**, OR any form action taken by
// a privileged actor (admin or card tester) anywhere — the latter catches admin actions
// that live outside /admin (home calendar CRUD, bingo adminReject) and an admin's own
// privileged use. Unauthorized POSTs to /admin endpoints are still caught (path-based)
// and recorded with their 403 status.
export function shouldAudit(event: RequestEvent): boolean {
	if (event.request.method !== 'POST') return false;
	if (event.url.pathname.startsWith('/admin')) return true;
	const user = event.locals.user;
	return isAdmin(user) || isCardTester(user);
}

// The form-action name from a SvelteKit ?/actionName URL. The action arrives as a
// search-param KEY beginning with '/' (value empty); the bare '?/' is the default action.
export function extractAction(url: URL): string | null {
	for (const key of url.searchParams.keys()) {
		if (key.startsWith('/')) {
			const name = key.slice(1);
			return name || '(default)';
		}
	}
	return null;
}

// Parse a (cloned) request's form body into a plain JSON object for the `payload`
// column. Files are reduced to metadata (never bytes); over-large bodies are skipped;
// repeated keys collapse into arrays; long strings are truncated. Never throws.
export async function capturePayload(request: Request): Promise<Record<string, unknown>> {
	try {
		const ct = request.headers.get('content-type') ?? '';
		const isForm = ct.includes('application/x-www-form-urlencoded') || ct.includes('multipart/form-data');
		if (!isForm) return {};

		const len = Number(request.headers.get('content-length') ?? 0);
		if (Number.isFinite(len) && len > MAX_BODY_BYTES) {
			return { _omitted: 'large body', bytes: len };
		}

		const form = await request.formData();
		const out: Record<string, unknown> = {};
		for (const [key, value] of form.entries()) {
			const entry =
				value instanceof File
					? { __file: { name: value.name, size: value.size, type: value.type } }
					: value.length > MAX_FIELD_CHARS
						? value.slice(0, MAX_FIELD_CHARS) + '…'
						: value;
			if (key in out) {
				// Repeated key (e.g. ability_name[], proof[]) → collect into an array.
				const prev = out[key];
				if (Array.isArray(prev)) prev.push(entry);
				else out[key] = [prev, entry];
			} else {
				out[key] = entry;
			}
		}
		return out;
	} catch (e) {
		return { _error: 'payload parse failed', message: e instanceof Error ? e.message : String(e) };
	}
}

// Capture the OLD state of a row BEFORE a destructive DB edit so the viewer can show a
// before→after diff (otherwise we'd only have the new payload). Currently the generic
// Table Editor (/admin/tables/[table]) update/delete — read the row by id first. Returns
// the old row (stored as payload._before) or null. Best-effort; runs before resolve().
export async function captureBeforeState(
	event: RequestEvent,
	payload: Record<string, unknown>
): Promise<Record<string, unknown> | null> {
	try {
		if (event.route.id !== '/admin/tables/[table]') return null;
		const action = extractAction(event.url);
		if (action !== 'update' && action !== 'delete') return null;
		const table = event.params.table;
		const id = typeof payload.id === 'string' ? payload.id : null;
		if (!table || !id) return null;
		const { data } = await db().from(table).select('*').eq('id', id).maybeSingle();
		return (data as Record<string, unknown> | null) ?? null;
	} catch {
		return null;
	}
}

// ── Display-time enrichment: turn the catch-all payload into something readable ──────────
// Resolves the opaque ids in a payload to names (so "granted a pack" shows WHO + WHICH),
// and computes a before→after field diff for DB-row edits. Pure read-side: nothing here
// changes what's stored, so it also improves historical rows.

export interface AuditEnrichment {
	summary: string | null; // one-line human description (null → fall back to action)
	changes: { field: string; before: unknown; after: unknown }[] | null; // table-edit diff
	resolved: { key: string; label: string }[]; // id field → resolved name
}

interface EnrichInputRow {
	id: string;
	action: string | null;
	route_id: string | null;
	path: string | null;
	payload: unknown;
}

// Which lookup an id-bearing form field maps to.
const ID_FIELD_KIND: Record<string, 'user' | 'pack' | 'card' | 'team'> = {
	user_id: 'user',
	target_user_id: 'user',
	granted_by: 'user',
	created_by: 'user',
	reviewed_by: 'user',
	chosen_by: 'user',
	pack_id: 'pack',
	card_id: 'card',
	team_id: 'team'
};

function asObject(p: unknown): Record<string, unknown> {
	return p && typeof p === 'object' && !Array.isArray(p) ? (p as Record<string, unknown>) : {};
}

function stableStr(v: unknown): string {
	try {
		return JSON.stringify(v ?? null);
	} catch {
		return String(v);
	}
}

// Parse the table editor's `payload` field (a JSON string of the new row values). Null if
// missing/truncated/invalid (then we just skip the diff).
function parseRowJson(v: unknown): Record<string, unknown> | null {
	if (typeof v !== 'string' || v.endsWith('…')) return null;
	try {
		const parsed = JSON.parse(v);
		return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
	} catch {
		return null;
	}
}

function diffRow(before: unknown, payloadField: unknown): AuditEnrichment['changes'] {
	const after = parseRowJson(payloadField);
	if (!after) return null;
	const b = asObject(before);
	const out: { field: string; before: unknown; after: unknown }[] = [];
	for (const k of Object.keys(after)) {
		if (k === 'id') continue;
		if (stableStr(b[k]) !== stableStr(after[k])) {
			out.push({ field: k, before: k in b ? b[k] : null, after: after[k] });
		}
	}
	return out;
}

function tableFromPath(path: string | null): string {
	return path ? path.split('/').filter(Boolean).pop() ?? 'a table' : 'a table';
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Gather every uuid-shaped string anywhere in a payload — including inside the table
// editor's stringified `payload`/`_before` — so we can resolve which ones are USERS and
// render their RSN everywhere (not just known id fields).
function collectUuids(value: unknown, into: Set<string>, depth = 0): void {
	if (depth > 6) return;
	if (typeof value === 'string') {
		if (UUID_RE.test(value)) into.add(value);
		else {
			const t = value.trim();
			if ((t.startsWith('{') || t.startsWith('[')) && !value.endsWith('…')) {
				try {
					collectUuids(JSON.parse(t), into, depth + 1);
				} catch {
					/* not JSON */
				}
			}
		}
	} else if (Array.isArray(value)) {
		for (const v of value) collectUuids(v, into, depth + 1);
	} else if (value && typeof value === 'object') {
		for (const v of Object.values(value)) collectUuids(v, into, depth + 1);
	}
}

// Resolve the ids in every row, then build per-row summary + diff + resolved-name list.
// Also returns a global userId→RSN map so the viewer can replace EVERY user id (anywhere
// in the payload/diff) with the person's RSN.
export async function enrichAuditRows(
	rows: EnrichInputRow[]
): Promise<{ byRow: Map<string, AuditEnrichment>; userNames: Record<string, string> }> {
	const uuids = new Set<string>(); // every uuid anywhere (candidates for "is a user")
	const need = { pack: new Set<string>(), card: new Set<string>(), team: new Set<string>() };
	for (const r of rows) {
		collectUuids(r.payload, uuids);
		for (const [k, v] of Object.entries(asObject(r.payload))) {
			const kind = ID_FIELD_KIND[k];
			if ((kind === 'pack' || kind === 'card' || kind === 'team') && typeof v === 'string' && v) need[kind].add(v);
		}
	}

	const sb = db();
	const empty = Promise.resolve({ data: [] as { id: string; [c: string]: unknown }[] });
	const [users, packs, cards, teams] = await Promise.all([
		uuids.size ? sb.from('vs_users').select('id, rsn, discord_username').in('id', [...uuids]) : empty,
		need.pack.size ? sb.from('vs_card_packs').select('id, name').in('id', [...need.pack]) : empty,
		need.card.size ? sb.from('vs_cards').select('id, name').in('id', [...need.card]) : empty,
		need.team.size ? sb.from('vs_teams').select('id, name').in('id', [...need.team]) : empty
	]);
	// Only ids that actually matched a vs_users row land here, so pack/card/team/event uuids
	// (which never match) are left untouched.
	const userMap = new Map(
		((users.data ?? []) as { id: string; rsn: string | null; discord_username: string | null }[]).map((u) => [
			u.id,
			u.rsn || u.discord_username || u.id
		])
	);
	const packMap = new Map(((packs.data ?? []) as { id: string; name: string | null }[]).map((p) => [p.id, p.name || p.id]));
	const cardMap = new Map(((cards.data ?? []) as { id: string; name: string | null }[]).map((c) => [c.id, c.name || c.id]));
	const teamMap = new Map(
		((teams.data ?? []) as { id: string; name: string | null }[]).map((t) => [t.id, t.name || `team ${t.id.slice(0, 8)}`])
	);
	const mapFor = (kind: string) =>
		kind === 'user' ? userMap : kind === 'pack' ? packMap : kind === 'card' ? cardMap : teamMap;

	const byRow = new Map<string, AuditEnrichment>();
	for (const r of rows) {
		const p = asObject(r.payload);

		const resolved: { key: string; label: string }[] = [];
		for (const [k, v] of Object.entries(p)) {
			const kind = ID_FIELD_KIND[k];
			if (kind && typeof v === 'string' && v) {
				const name = mapFor(kind).get(v);
				if (name) resolved.push({ key: k, label: name });
			}
		}

		const isTableEdit = r.route_id === '/admin/tables/[table]';
		const changes = isTableEdit && r.action === 'update' && '_before' in p ? diffRow(p._before, p.payload) : null;

		byRow.set(r.id, { summary: buildSummary(r, p, { packMap, userMap }, changes), changes, resolved });
	}
	return { byRow, userNames: Object.fromEntries(userMap) };
}

function buildSummary(
	r: EnrichInputRow,
	p: Record<string, unknown>,
	maps: { packMap: Map<string, string>; userMap: Map<string, string> },
	changes: AuditEnrichment['changes']
): string | null {
	const action = r.action;

	if (action === 'grantPacks') {
		const pack = (typeof p.pack_id === 'string' && maps.packMap.get(p.pack_id)) || 'a pack';
		const qty = String(p.quantity ?? '1');
		const noun = qty === '1' ? 'pack' : 'packs';
		if (p.target === 'all') return `Granted ${qty} ${pack} ${noun} to everyone`;
		const who = (typeof p.user_id === 'string' && maps.userMap.get(p.user_id)) || 'a member';
		return `Granted ${qty} ${pack} ${noun} to ${who}`;
	}

	if (r.route_id === '/admin/tables/[table]') {
		const table = tableFromPath(r.path);
		const idShort = typeof p.id === 'string' ? ` #${p.id.slice(0, 8)}` : '';
		if (action === 'insert') return `Inserted a row into ${table}`;
		if (action === 'delete') return `Deleted ${table}${idShort}`;
		if (action === 'update') {
			const n = changes?.length ?? 0;
			return `Updated ${table}${idShort}${n ? ` — ${n} field${n === 1 ? '' : 's'} changed` : ''}`;
		}
	}

	if (r.route_id === '/admin/config' && action === 'save' && typeof p.config_name === 'string') {
		return `Updated bot config “${p.config_name}”`;
	}

	return null;
}

// Insert one audit row. Best-effort: swallows all errors. Call WITHOUT awaiting from
// the hook so it never adds latency to the response.
export async function logAudit(
	event: RequestEvent,
	status: number,
	payload: Record<string, unknown>
): Promise<void> {
	try {
		const user = event.locals.user;
		let ip: string | null = null;
		try {
			ip = event.getClientAddress();
		} catch {
			ip = null; // some adapters/contexts can't resolve an address
		}

		await db()
			.from('vs_audit_log')
			.insert({
				actor_user_id: user?.id ?? null,
				actor_discord_id: user?.discord_id ?? null,
				actor_name: user ? user.rsn || user.discord_username : null,
				is_admin: isAdmin(user),
				is_card_tester: isCardTester(user),
				method: event.request.method,
				route_id: event.route.id ?? null,
				path: event.url.pathname,
				action: extractAction(event.url),
				status,
				payload,
				ip,
				user_agent: event.request.headers.get('user-agent')
			});
	} catch (e) {
		console.error('[audit] failed to record:', e instanceof Error ? e.message : e);
	}
}
