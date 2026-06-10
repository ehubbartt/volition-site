import { redirect, error, fail } from '@sveltejs/kit';
import { z } from 'zod';
import { db } from '$lib/server/db';
import { isAdmin } from '$lib/server/auth';
import { markdownPreview } from '$lib/markdown';
import { SIMPLE_EVENT_KIND, EVENT_TASK_KIND, slugify } from '$lib/events/simple';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) throw redirect(303, '/');
	if (!isAdmin(locals.user)) throw error(403, 'Not allowed');

	const [eventsRes, packsRes] = await Promise.all([
		db()
			.from('vs_events')
			.select(
				'id, slug, name, kind, description, status, signup_opens_at, signup_closes_at, starts_at, ends_at, team_size, created_at'
			)
			.order('created_at', { ascending: false }),
		// Pack names power the create form's reward <datalist>.
		db().from('vs_card_packs').select('name').order('name', { ascending: true })
	]);

	if (eventsRes.error) throw error(500, eventsRes.error.message);

	return {
		events: (eventsRes.data ?? []).map((ev) => ({
			...ev,
			description_preview: markdownPreview(ev.description, 200)
		})),
		packNames: (packsRes.data ?? []).map((p) => p.name as string)
	};
};

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

export const actions: Actions = {
	create: async ({ locals, request }) => {
		if (!locals.user || !isAdmin(locals.user)) throw error(403, 'Not allowed');

		const form = await request.formData();
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

		const { error: insertError } = await db()
			.from('vs_events')
			.insert({
				slug: parsed.data.slug,
				name: parsed.data.name,
				description: parsed.data.description,
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

		return { ok: true };
	},

	// Create a SIMPLE EVENT from the template: one vs_events row (kind='simple') +
	// N vs_tasks objective rows (kind='event_task', event_id set). Each objective
	// carries its own VP / pack reward, reusing the task reward pipeline. Created as
	// a draft — the admin opens it from the manage page when ready.
	createSimpleEvent: async ({ locals, request }) => {
		if (!locals.user || !isAdmin(locals.user)) throw error(403, 'Not allowed');

		const form = await request.formData();
		const name = form.get('name')?.toString().trim() ?? '';
		if (!name) return fail(400, { error: 'Event name is required' });
		const description = form.get('description')?.toString().trim() || null;

		// Parallel task fields: task_name[] / task_desc[] / task_vp[] / task_pack[].
		const names = form.getAll('task_name').map((v) => v.toString().trim());
		const descs = form.getAll('task_desc').map((v) => v.toString().trim());
		const vps = form.getAll('task_vp').map((v) => v.toString());
		const packs = form.getAll('task_pack').map((v) => v.toString().trim());

		const tasks = names
			.map((n, i) => ({
				name: n,
				description: descs[i]?.trim() || null,
				vp_reward: Math.max(0, parseInt(vps[i] ?? '0', 10) || 0),
				pack_reward: packs[i] || null
			}))
			.filter((t) => t.name); // drop blank rows
		if (tasks.length === 0) return fail(400, { error: 'Add at least one task' });

		const slug = await uniqueEventSlug(name);

		const { data: ev, error: insErr } = await db()
			.from('vs_events')
			.insert({
				slug,
				name,
				description,
				kind: SIMPLE_EVENT_KIND,
				status: 'draft',
				team_size: 1,
				starts_at: normalizeDate(form.get('starts_at')),
				ends_at: normalizeDate(form.get('ends_at'))
			})
			.select('id')
			.single();
		if (insErr || !ev) return fail(500, { error: insErr?.message ?? 'Could not create event' });

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
			// Roll back the orphaned event so a retry starts clean.
			await db().from('vs_events').delete().eq('id', ev.id);
			return fail(500, { error: taskErr.message });
		}

		throw redirect(303, `/admin/events/${slug}`);
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

		return { ok: true };
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

		return { ok: true };
	}
};
