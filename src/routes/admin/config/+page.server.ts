import { redirect, error, fail } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { isSuperAdmin } from '$lib/server/auth';
import type { Actions, PageServerLoad } from './$types';

// Bot config editor (migrated from volition-admin-dashboard). Reads/writes the bot's
// bot_config table — each row is a named config in a group, with a jsonb config_value.
// SUPER-ADMIN only (same gate as the table editor): these values drive the live bot.
// Changes take effect within ~60s (the bot polls bot_config); no restart needed.

export type BotConfig = {
	config_name: string;
	config_group: string;
	config_value: unknown;
	description: string | null;
	updated_at: string | null;
};

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) throw redirect(303, '/');
	if (!isSuperAdmin(locals.user)) throw error(403, 'Not allowed');

	const { data, error: qErr } = await db()
		.from('bot_config')
		.select('config_name, config_group, config_value, description, updated_at')
		.order('config_group', { ascending: true })
		.order('config_name', { ascending: true });

	if (qErr) return { configs: [] as BotConfig[], loadError: qErr.message };
	return { configs: (data ?? []) as BotConfig[] };
};

export const actions: Actions = {
	save: async ({ locals, request }) => {
		if (!locals.user) throw redirect(303, '/');
		if (!isSuperAdmin(locals.user)) return fail(403, { error: 'Not allowed' });

		const form = await request.formData();
		const config_name = form.get('config_name')?.toString() ?? '';
		const raw = form.get('config_value')?.toString() ?? '';
		if (!config_name) return fail(400, { error: 'Missing config_name' });

		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch {
			return fail(400, { error: 'Invalid JSON value', config_name });
		}

		const { error: uErr } = await db()
			.from('bot_config')
			.update({ config_value: parsed, updated_at: new Date().toISOString() })
			.eq('config_name', config_name);

		if (uErr) return fail(500, { error: uErr.message, config_name });
		return { ok: true, config_name };
	}
};
