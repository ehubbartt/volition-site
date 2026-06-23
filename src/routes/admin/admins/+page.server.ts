import { redirect, error, fail } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import {
	isSuperAdmin,
	envAdminIds,
	envSuperAdminIds,
	envCardTesterIds
} from '$lib/server/auth';
import { ensureFreshAdminRoles } from '$lib/server/adminRoles';
import type { Actions, PageServerLoad } from './$types';

// Owner-only management of website admin access (SUPER_ADMIN gated).
//
// Owners themselves stay env-rooted (SUPER_ADMIN_DISCORD_IDS) and are shown here
// read-only. From this page owners GRANT/REVOKE the 'admin' and 'card_tester' roles,
// stored in vs_admin_roles. super_admin is intentionally not grantable from the DB.

type GrantableRole = 'admin' | 'card_tester';
const GRANTABLE: GrantableRole[] = ['admin', 'card_tester'];

export type DbGrant = {
	id: string;
	discord_id: string;
	role: GrantableRole;
	granted_by: string;
	note: string | null;
	created_at: string;
};

const isSnowflake = (s: string) => /^\d{15,21}$/.test(s);

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) throw redirect(303, '/');
	if (!isSuperAdmin(locals.user)) throw error(403, 'Not allowed');

	const { data, error: qErr } = await db()
		.from('vs_admin_roles')
		.select('id, discord_id, role, granted_by, note, created_at')
		.order('created_at', { ascending: false });

	const grants = (data ?? []) as DbGrant[];

	// Resolve Discord usernames for every id we display (env + DB grants) so the
	// table isn't a wall of raw IDs. Best-effort; missing names just show the id.
	const ids = new Set<string>([
		...envSuperAdminIds(),
		...envAdminIds(),
		...envCardTesterIds(),
		...grants.map((g) => g.discord_id),
		...grants.map((g) => g.granted_by)
	]);
	const usernames: Record<string, string> = {};
	if (ids.size > 0) {
		const { data: users } = await db()
			.from('vs_users')
			.select('discord_id, discord_username')
			.in('discord_id', [...ids]);
		for (const u of users ?? []) usernames[u.discord_id] = u.discord_username;
	}

	return {
		envSuperAdmins: envSuperAdminIds(),
		envAdmins: envAdminIds(),
		envCardTesters: envCardTesterIds(),
		grants,
		usernames,
		loadError: qErr?.message ?? null
	};
};

export const actions: Actions = {
	grant: async ({ locals, request }) => {
		if (!locals.user) throw redirect(303, '/');
		if (!isSuperAdmin(locals.user)) return fail(403, { error: 'Not allowed' });

		const form = await request.formData();
		const discord_id = (form.get('discord_id')?.toString() ?? '').trim();
		const role = (form.get('role')?.toString() ?? '').trim();
		const note = (form.get('note')?.toString() ?? '').trim() || null;

		if (!isSnowflake(discord_id)) {
			return fail(400, { error: 'Enter a valid Discord user ID (15–21 digits).' });
		}
		if (!GRANTABLE.includes(role as GrantableRole)) {
			return fail(400, { error: 'Role must be admin or card_tester.' });
		}

		const { error: iErr } = await db().from('vs_admin_roles').insert({
			discord_id,
			role,
			granted_by: locals.user.discord_id,
			note
		});

		if (iErr) {
			// 23505 = unique_violation (this id already has this role)
			if (iErr.code === '23505') {
				return fail(409, { error: 'That user already has this role.' });
			}
			return fail(500, { error: iErr.message });
		}

		await ensureFreshAdminRoles(true); // apply immediately on this machine
		return { ok: true, granted: { discord_id, role } };
	},

	revoke: async ({ locals, request }) => {
		if (!locals.user) throw redirect(303, '/');
		if (!isSuperAdmin(locals.user)) return fail(403, { error: 'Not allowed' });

		const form = await request.formData();
		const id = (form.get('id')?.toString() ?? '').trim();
		if (!id) return fail(400, { error: 'Missing grant id.' });

		const { error: dErr } = await db().from('vs_admin_roles').delete().eq('id', id);
		if (dErr) return fail(500, { error: dErr.message });

		await ensureFreshAdminRoles(true);
		return { ok: true, revoked: id };
	}
};
