import { redirect, error } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import {
	isAdmin,
	envAdminIds,
	envSuperAdminIds,
	envCardTesterIds
} from '$lib/server/auth';
import type { PageServerLoad } from './$types';

// Read-only "how is the bot set up right now" overview. Admin-gated (not super-admin):
// any admin should be able to SEE current configuration; editing still happens behind
// the super-admin gates on /admin/config and /admin/admins, which this page links to.

type ConfigRow = {
	config_name: string;
	config_group: string;
	config_value: unknown;
	description: string | null;
	updated_at: string | null;
};

export type ConfigSummary = {
	config_name: string;
	config_group: string;
	description: string | null;
	updated_at: string | null;
	kind: 'object' | 'array' | 'scalar';
	entryCount: number | null; // keys (object) or length (array); null for scalars
	keys: string[]; // first handful of keys/slugs for a quick glance
};

function summarize(row: ConfigRow): ConfigSummary {
	const v = row.config_value;
	let kind: ConfigSummary['kind'] = 'scalar';
	let entryCount: number | null = null;
	let keys: string[] = [];
	if (Array.isArray(v)) {
		kind = 'array';
		entryCount = v.length;
	} else if (v && typeof v === 'object') {
		kind = 'object';
		const k = Object.keys(v as Record<string, unknown>);
		entryCount = k.length;
		keys = k.slice(0, 12);
	}
	return {
		config_name: row.config_name,
		config_group: row.config_group,
		description: row.description,
		updated_at: row.updated_at,
		kind,
		entryCount,
		keys
	};
}

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) throw redirect(303, '/');
	if (!isAdmin(locals.user)) throw error(403, 'Not allowed');

	// Bot configuration (the bot_config table the bot hot-reloads).
	const { data: cfg, error: cfgErr } = await db()
		.from('bot_config')
		.select('config_name, config_group, config_value, description, updated_at')
		.order('config_group', { ascending: true })
		.order('config_name', { ascending: true });

	const configs = ((cfg ?? []) as ConfigRow[]).map(summarize);

	// Admin roster = env-rooted lists + DB grants from vs_admin_roles.
	const { data: grantRows } = await db()
		.from('vs_admin_roles')
		.select('discord_id, role')
		.order('created_at', { ascending: false });
	const grants = (grantRows ?? []) as { discord_id: string; role: string }[];

	const dbAdmins = grants.filter((g) => g.role === 'admin').map((g) => g.discord_id);
	const dbCardTesters = grants
		.filter((g) => g.role === 'card_tester')
		.map((g) => g.discord_id);

	// Resolve usernames for everyone we list, best-effort.
	const ids = new Set<string>([
		...envSuperAdminIds(),
		...envAdminIds(),
		...envCardTesterIds(),
		...dbAdmins,
		...dbCardTesters
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
		configs,
		loadError: cfgErr?.message ?? null,
		roster: {
			owners: envSuperAdminIds(),
			envAdmins: envAdminIds(),
			dbAdmins,
			envCardTesters: envCardTesterIds(),
			dbCardTesters
		},
		usernames
	};
};
