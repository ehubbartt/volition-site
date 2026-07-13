import { error } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { db } from '$lib/server/db';
import { isAdmin } from '$lib/server/auth';
import type { PageServerLoad } from './$types';

// Staging-only, admin-only diagnostic for the RLS lockdown (see
// db/scripts/rls_test.sql). It probes the throwaway vs_rls_test objects with the
// app's OWN Supabase client, so you can watch what the app can see flip when you
// enable RLS. 404s in prod (only exists where STAGING_ADMIN_ONLY is set), so it's
// inert even if this branch merges to prod.

const isStaging = /^(1|true|on|yes)$/i.test((env.STAGING_ADMIN_ONLY ?? '').trim());

type Probe = { readable: boolean; detail: string };

async function probeTable(): Promise<Probe> {
	// An RLS-denied SELECT returns [] with NO error, so row count is the signal.
	const { data, error: e } = await db().from('vs_rls_test').select('id, note');
	if (e) return { readable: false, detail: `error: ${e.message}` };
	const n = data?.length ?? 0;
	return { readable: n > 0, detail: `${n} row${n === 1 ? '' : 's'} returned` };
}

async function probeView(): Promise<Probe> {
	const { data, error: e } = await db().from('vs_rls_test_view').select('id');
	if (e) return { readable: false, detail: `error: ${e.message}` };
	const n = data?.length ?? 0;
	return { readable: n > 0, detail: `${n} row${n === 1 ? '' : 's'} returned` };
}

async function probeFn(): Promise<Probe> {
	const { data, error: e } = await db().rpc('vs_rls_test_fn');
	if (e) return { readable: false, detail: `error: ${e.message}` };
	return { readable: data != null, detail: `returned: ${JSON.stringify(data)}` };
}

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user || !isAdmin(locals.user)) throw error(403, 'Not allowed');
	if (!isStaging) throw error(404, 'Not found');

	const [table, view, rpc] = await Promise.all([probeTable(), probeView(), probeFn()]);

	return {
		// Boolean only — never the key itself. Tells you which outcome to expect.
		usingServiceKey: !!env.SUPABASE_SERVICE_ROLE_KEY,
		probes: { table, view, rpc }
	};
};
