import { redirect, error } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { isSuperAdmin } from '$lib/server/auth';
import type { PageServerLoad } from './$types';

// Generic DB table editor (migrated from volition-admin-dashboard). SUPER-ADMIN only —
// this reads/writes ANY table in the shared Supabase project (the site's vs_* tables AND
// the bot's), so it's gated to a tiny trusted allow-list (SUPER_ADMIN_DISCORD_IDS).

// Internal / never-edit tables.
const HIDDEN_TABLES = ['schema_migrations', '_prisma_migrations'];

// Fallback probe list if the get_public_tables RPC isn't available. Covers the bot's
// tables plus the site's vs_* tables.
const PROBE_TABLES = [
	'players',
	'wallet_items',
	'bot_config',
	'reroll_tokens',
	'clan_leavers',
	'lootcrate_rare_drops',
	'lootcrate_daily_metrics',
	'voice_user_stats',
	'voice_daily_metrics',
	'voice_activity_log',
	'events',
	'event_submissions',
	'sotw',
	'botw',
	'vs_users',
	'vs_sessions',
	'vs_events',
	'vs_tasks',
	'vs_submissions',
	'vs_calendar_events',
	'vs_teams',
	'vs_event_signups',
	'vs_team_invites',
	'vs_bingo_completions',
	'vs_team_completions',
	'vs_team_path_choices',
	'vs_cards',
	'vs_user_cards',
	'vs_card_packs',
	'vs_user_packs',
	'vs_audit_log'
];

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) throw redirect(303, '/');
	if (!isSuperAdmin(locals.user)) throw error(403, 'Not allowed');

	let tables: string[] = [];

	// Prefer the RPC (returns every public table) — same one the old dashboard used.
	const { data: rpcData, error: rpcErr } = await db().rpc('get_public_tables');
	if (!rpcErr && Array.isArray(rpcData)) {
		tables = (rpcData as Array<{ table_name: string }>).map((t) => t.table_name);
	} else {
		// Fallback: probe each candidate table for existence.
		const checks = await Promise.all(
			PROBE_TABLES.map(async (t) => {
				const { error: e } = await db().from(t).select('*').limit(0);
				return e ? null : t;
			})
		);
		tables = checks.filter((t): t is string => !!t);
	}

	tables = tables.filter((t) => !HIDDEN_TABLES.includes(t) && !t.startsWith('_')).sort();

	// Split site vs bot tables for display grouping.
	const site = tables.filter((t) => t.startsWith('vs_'));
	const other = tables.filter((t) => !t.startsWith('vs_'));

	return { tables, site, other };
};
