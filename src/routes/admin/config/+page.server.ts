import { redirect, error, fail } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { isSuperAdmin } from '$lib/server/auth';
import { validateConfigValue } from '$lib/admin/configSchemas';
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

		// Schema-validate before writing so a malformed blob can't reach the bot, which
		// parses these values live. Unknown config_names have no schema and pass through.
		const check = validateConfigValue(config_name, parsed);
		if (!check.ok) return fail(400, { error: check.error, config_name });

		const { error: uErr } = await db()
			.from('bot_config')
			.update({ config_value: parsed, updated_at: new Date().toISOString() })
			.eq('config_name', config_name);

		if (uErr) return fail(500, { error: uErr.message, config_name });
		return { ok: true, config_name };
	},

	// Update a SINGLE key inside a config group's value via read-merge-write, instead of
	// overwriting the whole blob. Guards against the lost-update problem when several
	// admins edit different entries of the same config (e.g. different command_messages
	// slugs): an optimistic `updated_at` check rejects a save built on a stale read.
	// The merged result is schema-validated before it's written.
	saveEntry: async ({ locals, request }) => {
		if (!locals.user) throw redirect(303, '/');
		if (!isSuperAdmin(locals.user)) return fail(403, { error: 'Not allowed' });

		const form = await request.formData();
		const config_name = form.get('config_name')?.toString() ?? '';
		const key = form.get('key')?.toString() ?? '';
		const raw = form.get('value')?.toString() ?? '';
		const expectedUpdatedAt = form.get('expected_updated_at')?.toString() || null;
		if (!config_name) return fail(400, { error: 'Missing config_name' });
		if (!key) return fail(400, { error: 'Missing key', config_name });

		let entry: unknown;
		try {
			entry = JSON.parse(raw);
		} catch {
			return fail(400, { error: 'Invalid JSON value', config_name });
		}

		// Read the current row so we merge onto the freshest value (and can diff updated_at).
		const { data: current, error: rErr } = await db()
			.from('bot_config')
			.select('config_value, updated_at')
			.eq('config_name', config_name)
			.maybeSingle();
		if (rErr) return fail(500, { error: rErr.message, config_name });
		if (!current) return fail(404, { error: 'Config not found', config_name });

		// Optimistic concurrency: if the row changed since the editor loaded it, refuse so
		// the admin re-reads rather than silently clobbering someone else's edit.
		if (expectedUpdatedAt && current.updated_at && current.updated_at !== expectedUpdatedAt) {
			return fail(409, {
				error: 'This config changed since you loaded it. Reload and reapply your edit.',
				config_name
			});
		}

		const base =
			current.config_value && typeof current.config_value === 'object'
				? (current.config_value as Record<string, unknown>)
				: {};
		const merged = { ...base, [key]: entry };

		const check = validateConfigValue(config_name, merged);
		if (!check.ok) return fail(400, { error: check.error, config_name });

		const nextUpdatedAt = new Date().toISOString();
		const { error: uErr } = await db()
			.from('bot_config')
			.update({ config_value: merged, updated_at: nextUpdatedAt })
			.eq('config_name', config_name);
		if (uErr) return fail(500, { error: uErr.message, config_name });

		return { ok: true, config_name, key, updated_at: nextUpdatedAt };
	}
};
