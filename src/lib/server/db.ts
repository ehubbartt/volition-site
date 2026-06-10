import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { env } from '$env/dynamic/private';

let _client: SupabaseClient | null = null;

export function db(): SupabaseClient {
	if (_client) return _client;

	const url = env.SUPABASE_URL;
	const key = env.SUPABASE_ANON_KEY;

	if (!url || !key) {
		throw new Error('SUPABASE_URL and SUPABASE_ANON_KEY must be set');
	}

	_client = createClient(url, key, {
		auth: {
			autoRefreshToken: false,
			persistSession: false
		}
	});

	return _client;
}

// PostgREST caps a plain .select() at 1000 rows by default, so any full-table read
// (stats, aggregations) silently truncates once a table grows past 1000 rows. This
// pages through in 1000-row batches until exhausted and returns every row. Use it
// for unfiltered/large reads where you need the COMPLETE set, not a page.
const PAGE_SIZE = 1000;

export async function selectAll<T = Record<string, unknown>>(
	table: string,
	columns: string
): Promise<T[]> {
	const out: T[] = [];
	for (let from = 0; ; from += PAGE_SIZE) {
		const { data, error } = await db()
			.from(table)
			.select(columns)
			.range(from, from + PAGE_SIZE - 1);
		if (error) throw new Error(`selectAll(${table}): ${error.message}`);
		const rows = (data ?? []) as T[];
		out.push(...rows);
		if (rows.length < PAGE_SIZE) break;
	}
	return out;
}
