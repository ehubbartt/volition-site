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
// Cap any single captured string so a giant textarea can't bloat a row.
const MAX_FIELD_CHARS = 2000;

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
