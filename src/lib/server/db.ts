import { createClient, type SupabaseClient, type PostgrestError } from '@supabase/supabase-js';
import { env } from '$env/dynamic/private';

let _client: SupabaseClient | null = null;

export function db(): SupabaseClient {
	if (_client) return _client;

	const url = env.SUPABASE_URL;
	// Prefer the service-role key: with RLS enabled on every table (deny-all, no
	// policies — see db/scripts/enable_rls.sql) the anon key can read/write NOTHING,
	// and this server-only client is what bypasses RLS. The anon fallback keeps dev
	// environments working before the secret is provisioned.
	const key = env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_ANON_KEY;

	if (!url || !key) {
		throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_ANON_KEY) must be set');
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

// Like selectAll but for a FILTERED/ORDERED query: pass a factory that applies .range(from,to)
// to your built query (with its own .eq()/.order()/embeds). Pages past the 1000-row cap and
// returns every matching row. Use for event-scoped reads that can exceed 1000 rows — e.g. ALL
// of a duo event's submissions, where truncation silently broke board progress once the event
// passed 1000 submissions (oldest 1000 returned, newest dropped).
export async function fetchAllFiltered<T = Record<string, unknown>>(
	make: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: PostgrestError | null }>
): Promise<{ data: T[]; error: PostgrestError | null }> {
	const out: T[] = [];
	for (let from = 0; ; from += PAGE_SIZE) {
		const { data, error } = await make(from, from + PAGE_SIZE - 1);
		if (error) return { data: out, error };
		const rows = data ?? [];
		out.push(...rows);
		if (rows.length < PAGE_SIZE) break;
	}
	return { data: out, error: null };
}
