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
