import { redirect, error, fail } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { isSuperAdmin } from '$lib/server/auth';
import type { Actions, PageServerLoad } from './$types';

const BLOCKED = ['schema_migrations', '_prisma_migrations'];
const isBlocked = (t: string) => BLOCKED.includes(t) || t.startsWith('_');

export type ColumnMeta = {
	name: string;
	dataType: string;
	isNullable: boolean;
	hasDefault: boolean;
	isIdentity: boolean;
};

// Infer column types from names when the get_column_info RPC isn't available.
function inferMeta(columns: string[]): ColumnMeta[] {
	return columns.map((name) => {
		const l = name.toLowerCase();
		const isIdentity = l === 'id';
		const isTimestamp = l.includes('_at') || l.includes('date') || l.includes('timestamp');
		const isUuid = l === 'id' || l.endsWith('_id') || l.endsWith('_uuid');
		return {
			name,
			dataType: isTimestamp ? 'timestamp' : isUuid ? 'uuid' : 'text',
			isNullable: !isIdentity,
			hasDefault: isIdentity || isTimestamp,
			isIdentity
		};
	});
}

async function getColumnMeta(table: string, columns: string[]): Promise<ColumnMeta[]> {
	const { data, error: e } = await db().rpc('get_column_info', { p_table_name: table });
	if (!e && Array.isArray(data) && data.length > 0) {
		return (data as Array<Record<string, unknown>>).map((c) => ({
			name: String(c.column_name),
			dataType: String(c.data_type),
			isNullable: c.is_nullable === 'YES',
			hasDefault: c.column_default !== null,
			isIdentity: c.is_identity === 'YES' || c.identity_generation !== null
		}));
	}
	return inferMeta(columns);
}

export const load: PageServerLoad = async ({ locals, params, url }) => {
	if (!locals.user) throw redirect(303, '/');
	if (!isSuperAdmin(locals.user)) throw error(403, 'Not allowed');

	const table = params.table;
	if (isBlocked(table)) throw error(403, 'Table not allowed');

	const limit = Math.min(500, Math.max(1, parseInt(url.searchParams.get('limit') || '100')));
	const offset = Math.max(0, parseInt(url.searchParams.get('offset') || '0'));
	const search = url.searchParams.get('search') || '';
	const sortBy = url.searchParams.get('sortBy') || '';
	const sortDir = url.searchParams.get('sortDir') === 'desc' ? 'desc' : 'asc';

	let rows: Record<string, unknown>[] = [];
	let columns: string[] = [];
	let total = 0;

	if (search) {
		// Search needs a cross-column scan → fetch rows, filter in JS, then sort + paginate.
		// EXPLICIT bound (not the silent 1000 cap, not an unbounded pull-the-whole-table — some
		// bot tables are huge): scans up to SEARCH_SCAN rows. For full coverage of an enormous
		// table, browse it un-searched (that path is server-paginated).
		const SEARCH_SCAN = 10000;
		const { data, error: e } = await db().from(table).select('*').limit(SEARCH_SCAN);
		if (e) throw error(500, e.message);
		const all = (data ?? []) as Record<string, unknown>[];
		columns = all.length > 0 ? Object.keys(all[0]) : [];
		const q = search.toLowerCase();
		let filtered = all.filter((r) =>
			Object.values(r).some((v) => v !== null && String(v).toLowerCase().includes(q))
		);
		if (sortBy && columns.includes(sortBy)) {
			filtered = filtered.sort((a, b) => cmp(a[sortBy], b[sortBy], sortDir));
		}
		total = filtered.length;
		rows = filtered.slice(offset, offset + limit);
	} else {
		let query = db().from(table).select('*', { count: 'exact' });
		if (sortBy) query = query.order(sortBy, { ascending: sortDir === 'asc' });
		query = query.range(offset, offset + limit - 1);
		const { data, error: e, count } = await query;
		if (e) throw error(500, e.message);
		rows = (data ?? []) as Record<string, unknown>[];
		total = count ?? 0;
		// Column list: from a row, else a 1-row probe (so empty tables still show columns).
		columns = rows.length > 0 ? Object.keys(rows[0]) : [];
		if (columns.length === 0) {
			const probe = await db().from(table).select('*').limit(1);
			if (probe.data && probe.data.length > 0) columns = Object.keys(probe.data[0]);
		}
	}

	const columnMeta = await getColumnMeta(table, columns);
	if (columns.length === 0) columns = columnMeta.map((c) => c.name);

	return {
		table,
		rows,
		columns,
		columnMeta,
		total,
		limit,
		offset,
		sortBy,
		sortDir,
		search,
		hasId: columns.includes('id')
	};
};

function cmp(a: unknown, b: unknown, dir: 'asc' | 'desc'): number {
	const d = dir === 'asc' ? 1 : -1;
	if (a === null && b === null) return 0;
	if (a === null) return 1;
	if (b === null) return -1;
	if (typeof a === 'number' && typeof b === 'number') return (a - b) * d;
	return String(a).toLowerCase().localeCompare(String(b).toLowerCase()) * d;
}

function parsePayload(raw: string): Record<string, unknown> | null {
	try {
		const v = JSON.parse(raw);
		return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
	} catch {
		return null;
	}
}

export const actions: Actions = {
	insert: async ({ locals, params, request }) => {
		if (!locals.user) throw redirect(303, '/');
		if (!isSuperAdmin(locals.user)) return fail(403, { error: 'Not allowed' });
		const table = params.table;
		if (isBlocked(table)) return fail(403, { error: 'Table not allowed' });

		const form = await request.formData();
		const payload = parsePayload(form.get('payload')?.toString() ?? '');
		if (!payload) return fail(400, { error: 'Invalid payload' });
		// Drop empty id so the DB default/identity fills it.
		if (payload.id === '' || payload.id === null) delete payload.id;

		const { error: e } = await db().from(table).insert(payload);
		if (e) return fail(400, { error: e.message });
		return { ok: true, op: 'insert' };
	},

	update: async ({ locals, params, request }) => {
		if (!locals.user) throw redirect(303, '/');
		if (!isSuperAdmin(locals.user)) return fail(403, { error: 'Not allowed' });
		const table = params.table;
		if (isBlocked(table)) return fail(403, { error: 'Table not allowed' });

		const form = await request.formData();
		const id = form.get('id')?.toString();
		const payload = parsePayload(form.get('payload')?.toString() ?? '');
		if (!id) return fail(400, { error: 'Missing row id' });
		if (!payload) return fail(400, { error: 'Invalid payload' });
		delete payload.id;

		const { error: e } = await db().from(table).update(payload).eq('id', id);
		if (e) return fail(400, { error: e.message });
		return { ok: true, op: 'update' };
	},

	delete: async ({ locals, params, request }) => {
		if (!locals.user) throw redirect(303, '/');
		if (!isSuperAdmin(locals.user)) return fail(403, { error: 'Not allowed' });
		const table = params.table;
		if (isBlocked(table)) return fail(403, { error: 'Table not allowed' });

		const form = await request.formData();
		const id = form.get('id')?.toString();
		if (!id) return fail(400, { error: 'Missing row id' });

		const { error: e } = await db().from(table).delete().eq('id', id);
		if (e) return fail(400, { error: e.message });
		return { ok: true, op: 'delete' };
	}
};
