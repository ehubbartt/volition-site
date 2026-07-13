import { redirect, error, fail } from '@sveltejs/kit';
import { z } from 'zod';
import { db } from '$lib/server/db';
import { isAdmin } from '$lib/server/auth';
import { isTaskEvent, EVENT_TASK_KIND, slugify } from '$lib/events/simple';
import { cloneTemplateToEvent, listTemplates } from '$lib/server/eventStructure';
import { bustEventCaches } from '$lib/server/microCache';
import type { Actions } from './$types';

// ACTIONS ONLY — this page has no server load. Its data comes from
// /api/admin/events (built in $lib/server/admin/events.ts) via the universal
// load in +page.ts, so navigating here never waits on the server.

// Find a free slug derived from `name`: the base, else base-2, base-3, … (the slug
// column is unique). Falls back to a timestamped slug if `name` has no usable chars.
async function uniqueEventSlug(name: string): Promise<string> {
	const base = slugify(name) || `event-${Date.now()}`;
	const { data } = await db().from('vs_events').select('slug').like('slug', `${base}%`);
	const taken = new Set((data ?? []).map((r) => r.slug as string));
	if (!taken.has(base)) return base;
	for (let i = 2; i < 1000; i++) {
		const candidate = `${base}-${i}`;
		if (!taken.has(candidate)) return candidate;
	}
	return `${base}-${Date.now()}`;
}

const eventSchema = z.object({
	slug: z
		.string()
		.trim()
		.regex(/^[a-z0-9-]{2,60}$/, 'Slug must be 2-60 chars: lowercase letters, numbers, hyphens'),
	name: z.string().trim().min(1).max(120),
	description: z.string().max(10_000).optional().nullable(),
	team_size: z.coerce.number().int().min(1).max(20),
	status: z.enum(['draft', 'preview', 'open', 'locked', 'closed']),
	signup_opens_at: z.string().optional().nullable(),
	signup_closes_at: z.string().optional().nullable(),
	starts_at: z.string().optional().nullable(),
	ends_at: z.string().optional().nullable()
});

function normalizeDate(v: FormDataEntryValue | null): string | null {
	const s = v?.toString().trim();
	if (!s) return null;
	const d = new Date(s);
	if (Number.isNaN(d.getTime())) return null;
	return d.toISOString();
}

// Parse the repeatable task rows (task_name[]/task_desc[]/task_vp[]/task_pack[])
// from the task-event creator into clean objective rows; blank-name rows dropped.
function parseTaskRows(form: FormData) {
	const names = form.getAll('task_name').map((v) => v.toString().trim());
	const descs = form.getAll('task_desc').map((v) => v.toString().trim());
	const vps = form.getAll('task_vp').map((v) => v.toString());
	const packs = form.getAll('task_pack').map((v) => v.toString().trim());
	return names
		.map((n, i) => ({
			name: n,
			description: descs[i]?.trim() || null,
			vp_reward: Math.max(0, parseInt(vps[i] ?? '0', 10) || 0),
			pack_reward: packs[i] || null
		}))
		.filter((t) => t.name);
}

export const actions: Actions = {
	// The unified event creator. `kind` (the type dropdown) decides the shape:
	//   simple / sequential → a TASK EVENT: one vs_events row + N vs_tasks objective
	//     rows (kind='event_task', event_id set), each with its own VP/pack reward,
	//     reusing the task pipeline. 'sequential' tasks unlock in creation order.
	//     Created as a draft → admin opens it from the manage page.
	//   custom → an ADVANCED signup-based / bespoke event (slug, team_size, status,
	//     signup dates) — the legacy generic create, kept for one-off events.
	createEvent: async ({ locals, request }) => {
		if (!locals.user || !isAdmin(locals.user)) throw error(403, 'Not allowed');

		const form = await request.formData();
		const kind = form.get('kind')?.toString() ?? '';

		// ── Advanced / custom (signup-based) ────────────────────────────────
		if (kind === 'custom') {
			const parsed = eventSchema.safeParse({
				slug: form.get('slug'),
				name: form.get('name'),
				description: form.get('description') || null,
				team_size: form.get('team_size') ?? '2',
				status: form.get('status') ?? 'draft',
				signup_opens_at: form.get('signup_opens_at') || null,
				signup_closes_at: form.get('signup_closes_at') || null,
				starts_at: form.get('starts_at') || null,
				ends_at: form.get('ends_at') || null
			});
			if (!parsed.success) {
				return fail(400, { error: parsed.error.issues[0]?.message ?? 'Invalid input' });
			}
			const { error: insertError } = await db().from('vs_events').insert({
				slug: parsed.data.slug,
				name: parsed.data.name,
				description: parsed.data.description,
				kind: 'custom',
				owner_user_id: locals.user.id, // the admin who owns/hosts it (shown as "who to contact")
				team_size: parsed.data.team_size,
				status: parsed.data.status,
				signup_opens_at: normalizeDate(form.get('signup_opens_at')),
				signup_closes_at: normalizeDate(form.get('signup_closes_at')),
				starts_at: normalizeDate(form.get('starts_at')),
				ends_at: normalizeDate(form.get('ends_at'))
			});
			if (insertError) {
				if (insertError.message.includes('duplicate')) {
					return fail(409, { error: 'An event with that slug already exists' });
				}
				return fail(500, { error: insertError.message });
			}
			bustEventCaches();
			return { ok: true };
		}

		// ── Task event (open / sequential) ──────────────────────────────────
		if (!isTaskEvent(kind)) return fail(400, { error: 'Pick an event type' });

		const name = form.get('name')?.toString().trim() ?? '';
		if (!name) return fail(400, { error: 'Event name is required' });
		const description = form.get('description')?.toString().trim() || null;

		const tasks = parseTaskRows(form);
		if (tasks.length === 0) return fail(400, { error: 'Add at least one task' });

		const slug = await uniqueEventSlug(name);

		const { data: ev, error: insErr } = await db()
			.from('vs_events')
			.insert({
				slug,
				name,
				description,
				kind,
				owner_user_id: locals.user.id, // the admin who owns/hosts it
				status: 'draft',
				team_size: 1,
				starts_at: normalizeDate(form.get('starts_at')),
				ends_at: normalizeDate(form.get('ends_at'))
			})
			.select('id')
			.single();
		if (insErr || !ev) return fail(500, { error: insErr?.message ?? 'Could not create event' });

		// vs_tasks created in order → for 'sequential' that IS the unlock order.
		const rows = tasks.map((t) => ({
			name: t.name,
			description: t.description,
			kind: EVENT_TASK_KIND,
			recurrence: 'one_off',
			vp_reward: t.vp_reward,
			pack_reward: t.pack_reward,
			requires_proof: true,
			is_template: false,
			in_rotation: false,
			status: 'open',
			event_id: ev.id
		}));
		const { error: taskErr } = await db().from('vs_tasks').insert(rows);
		if (taskErr) {
			await db().from('vs_events').delete().eq('id', ev.id); // roll back the orphan
			return fail(500, { error: taskErr.message });
		}

		throw redirect(303, `/admin/events/${slug}`);
	},

	// Create a data-driven event from a template (bingo first) and clone its
	// structure + tiles, then jump straight into the builder.
	createFromTemplate: async ({ locals, request }) => {
		if (!locals.user || !isAdmin(locals.user)) throw error(403, 'Not allowed');

		const form = await request.formData();
		const name = form.get('name')?.toString().trim() ?? '';
		const templateSlug = form.get('template')?.toString().trim() ?? '';
		if (!name) return fail(400, { error: 'Event name is required' });
		if (!templateSlug) return fail(400, { error: 'Pick a template' });

		const template = listTemplates().find((t) => t.slug === templateSlug);
		if (!template) return fail(400, { error: 'Unknown template' });

		const slug = await uniqueEventSlug(name);
		const { data: ev, error: insErr } = await db()
			.from('vs_events')
			.insert({ slug, name, kind: template.kind, owner_user_id: locals.user.id, status: 'draft', team_size: 1 })
			.select('id')
			.single();
		if (insErr || !ev) return fail(500, { error: insErr?.message ?? 'Could not create event' });

		const clone = await cloneTemplateToEvent(ev.id, templateSlug);
		if (!clone.ok) {
			await db().from('vs_events').delete().eq('id', ev.id); // roll back the orphan
			return fail(500, { error: clone.error });
		}

		throw redirect(303, `/admin/events/${slug}/builder`);
	},

	update: async ({ locals, request }) => {
		if (!locals.user || !isAdmin(locals.user)) throw error(403, 'Not allowed');

		const form = await request.formData();
		const id = form.get('id')?.toString();
		if (!id) return fail(400, { error: 'Missing id' });

		const parsed = eventSchema.safeParse({
			slug: form.get('slug'),
			name: form.get('name'),
			description: form.get('description') || null,
			team_size: form.get('team_size') ?? '2',
			status: form.get('status') ?? 'draft',
			signup_opens_at: form.get('signup_opens_at') || null,
			signup_closes_at: form.get('signup_closes_at') || null,
			starts_at: form.get('starts_at') || null,
			ends_at: form.get('ends_at') || null
		});

		if (!parsed.success) {
			return fail(400, { error: parsed.error.issues[0]?.message ?? 'Invalid input' });
		}

		const { error: updateError } = await db()
			.from('vs_events')
			.update({
				slug: parsed.data.slug,
				name: parsed.data.name,
				description: parsed.data.description,
				team_size: parsed.data.team_size,
				status: parsed.data.status,
				signup_opens_at: normalizeDate(form.get('signup_opens_at')),
				signup_closes_at: normalizeDate(form.get('signup_closes_at')),
				starts_at: normalizeDate(form.get('starts_at')),
				ends_at: normalizeDate(form.get('ends_at'))
			})
			.eq('id', id);

		if (updateError) {
			if (updateError.message.includes('duplicate')) {
				return fail(409, { error: 'An event with that slug already exists' });
			}
			return fail(500, { error: updateError.message });
		}

		bustEventCaches();
		return { ok: true };
	},

	// Permanently delete an event and all its data. Children are removed in
	// FK-safe order first (signups reference teams, etc.), then the event row.
	// vs_event_tiles / vs_event_tracked_items also cascade; vs_dink_drops nulls out.
	deleteEvent: async ({ locals, request }) => {
		if (!locals.user || !isAdmin(locals.user)) throw error(403, 'Not allowed');

		const form = await request.formData();
		const id = form.get('id')?.toString();
		const confirmSlug = form.get('confirm_slug')?.toString().trim();
		if (!id) return fail(400, { error: 'Missing id' });

		const { data: ev } = await db().from('vs_events').select('slug').eq('id', id).maybeSingle();
		if (!ev) return fail(404, { error: 'Event not found' });
		// Typed-slug confirmation guards against deleting the wrong event.
		if (confirmSlug !== ev.slug) {
			return fail(400, { error: `Type the slug "${ev.slug}" to confirm deletion.` });
		}

		// Child rows scoped to this event, deleted before the parent. Best-effort per
		// table (some may be empty / not apply); the final event delete surfaces any
		// remaining FK blocker.
		const childTables = [
			'vs_submissions',
			'vs_bingo_completions',
			'vs_team_completions',
			'vs_team_invites',
			'vs_event_signups',
			'vs_teams',
			'vs_tasks',
			'vs_event_tracked_items',
			'vs_event_tiles'
		];
		for (const table of childTables) {
			await db().from(table).delete().eq('event_id', id);
		}

		const { error: delErr } = await db().from('vs_events').delete().eq('id', id);
		if (delErr) return fail(500, { error: delErr.message });
		bustEventCaches();
		return { ok: true, deleted: ev.slug };
	},

	updateStatus: async ({ locals, request }) => {
		if (!locals.user || !isAdmin(locals.user)) throw error(403, 'Not allowed');

		const form = await request.formData();
		const id = form.get('id')?.toString();
		const status = form.get('status')?.toString();

		if (!id || !status) return fail(400, { error: 'Missing fields' });
		if (!['draft', 'preview', 'open', 'locked', 'closed'].includes(status)) {
			return fail(400, { error: 'Invalid status' });
		}

		const { error: updateError } = await db()
			.from('vs_events')
			.update({ status })
			.eq('id', id);

		if (updateError) return fail(500, { error: updateError.message });

		bustEventCaches();
		return { ok: true };
	},

	updateDates: async ({ locals, request }) => {
		if (!locals.user || !isAdmin(locals.user)) throw error(403, 'Not allowed');

		const form = await request.formData();
		const id = form.get('id')?.toString();
		if (!id) return fail(400, { error: 'Missing id' });

		const { error: updateError } = await db()
			.from('vs_events')
			.update({
				signup_opens_at: normalizeDate(form.get('signup_opens_at')),
				signup_closes_at: normalizeDate(form.get('signup_closes_at')),
				starts_at: normalizeDate(form.get('starts_at')),
				ends_at: normalizeDate(form.get('ends_at'))
			})
			.eq('id', id);

		if (updateError) return fail(500, { error: updateError.message });

		bustEventCaches();
		return { ok: true };
	}
};
