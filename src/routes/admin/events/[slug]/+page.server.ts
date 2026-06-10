import { redirect, error, fail } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { isAdmin } from '$lib/server/auth';
import { EVENT_TASK_KIND, isTaskEvent } from '$lib/events/simple';
import type { Actions, PageServerLoad } from './$types';

// Manage a single TASK EVENT (open or sequential): edit meta + status + type, and
// CRUD its objective tasks (vs_tasks rows with event_id + kind='event_task').
// Reuses the same vs_tasks write patterns as /admin/tasks. isAdmin-gated.

function intOrZero(v: FormDataEntryValue | null): number {
	const n = parseInt((v ?? '').toString(), 10);
	return Number.isFinite(n) && n > 0 ? n : 0;
}

function normalizeDate(v: FormDataEntryValue | null): string | null {
	const s = v?.toString().trim();
	if (!s) return null;
	const d = new Date(s);
	return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

async function loadEvent(slug: string) {
	const { data: ev } = await db()
		.from('vs_events')
		.select('id, slug, name, kind, description, status, starts_at, ends_at')
		.eq('slug', slug)
		.maybeSingle();
	return ev;
}

// Guard every action: the slug must resolve to a task event (open/sequential) we own.
async function requireTaskEvent(slug: string) {
	const ev = await loadEvent(slug);
	if (!ev) return { error: fail(404, { error: 'Event not found' }) };
	if (!isTaskEvent(ev.kind)) return { error: fail(400, { error: 'Not a task event' }) };
	return { ev };
}

export const load: PageServerLoad = async ({ params, locals }) => {
	if (!locals.user) throw redirect(303, '/');
	if (!isAdmin(locals.user)) throw error(403, 'Not allowed');

	const ev = await loadEvent(params.slug);
	if (!ev) throw error(404, 'Event not found');
	if (!isTaskEvent(ev.kind)) throw redirect(303, '/admin/events');

	const [tasksRes, packsRes, pendingRes] = await Promise.all([
		db()
			.from('vs_tasks')
			.select('id, name, description, vp_reward, pack_reward, status, created_at')
			.eq('event_id', ev.id)
			.order('created_at', { ascending: true }),
		db().from('vs_card_packs').select('name').order('name', { ascending: true }),
		db().from('vs_submissions').select('id', { count: 'exact', head: true }).eq('status', 'pending')
	]);

	return {
		event: ev,
		tasks: tasksRes.data ?? [],
		packNames: (packsRes.data ?? []).map((p) => p.name as string),
		pendingTotal: pendingRes.count ?? 0
	};
};

export const actions: Actions = {
	// Edit event meta (name, description, dates).
	updateEvent: async ({ locals, request, params }) => {
		if (!locals.user || !isAdmin(locals.user)) throw error(403, 'Not allowed');
		const guard = await requireTaskEvent(params.slug);
		if (guard.error) return guard.error;

		const form = await request.formData();
		const name = form.get('name')?.toString().trim() ?? '';
		if (!name) return fail(400, { error: 'Event name is required' });

		// Allow switching the unlock mode (open ↔ sequential); ignore anything else.
		const kind = form.get('kind')?.toString();
		const patch: Record<string, unknown> = {
			name,
			description: form.get('description')?.toString().trim() || null,
			starts_at: normalizeDate(form.get('starts_at')),
			ends_at: normalizeDate(form.get('ends_at'))
		};
		if (isTaskEvent(kind)) patch.kind = kind;

		const { error: e } = await db().from('vs_events').update(patch).eq('id', guard.ev.id);
		if (e) return fail(500, { error: e.message });
		return { ok: true };
	},

	// Flip the event status (draft → open → closed, etc).
	setStatus: async ({ locals, request, params }) => {
		if (!locals.user || !isAdmin(locals.user)) throw error(403, 'Not allowed');
		const guard = await requireTaskEvent(params.slug);
		if (guard.error) return guard.error;

		const status = form_status(await request.formData());
		if (!status) return fail(400, { error: 'Invalid status' });

		const { error: e } = await db().from('vs_events').update({ status }).eq('id', guard.ev.id);
		if (e) return fail(500, { error: e.message });
		return { ok: true };
	},

	// Add an objective task to this event.
	addTask: async ({ locals, request, params }) => {
		if (!locals.user || !isAdmin(locals.user)) throw error(403, 'Not allowed');
		const guard = await requireTaskEvent(params.slug);
		if (guard.error) return guard.error;

		const form = await request.formData();
		const name = form.get('name')?.toString().trim() ?? '';
		if (!name) return fail(400, { error: 'Task name is required' });

		const { error: e } = await db().from('vs_tasks').insert({
			name,
			description: form.get('description')?.toString().trim() || null,
			kind: EVENT_TASK_KIND,
			recurrence: 'one_off',
			vp_reward: intOrZero(form.get('vp_reward')),
			pack_reward: form.get('pack_reward')?.toString().trim() || null,
			requires_proof: true,
			is_template: false,
			in_rotation: false,
			status: 'open',
			event_id: guard.ev.id
		});
		if (e) return fail(500, { error: e.message });
		return { ok: true };
	},

	// Edit an objective task's fields. Scoped to this event's tasks.
	updateTask: async ({ locals, request, params }) => {
		if (!locals.user || !isAdmin(locals.user)) throw error(403, 'Not allowed');
		const guard = await requireTaskEvent(params.slug);
		if (guard.error) return guard.error;

		const form = await request.formData();
		const id = form.get('id')?.toString();
		if (!id) return fail(400, { error: 'Missing task id' });
		const name = form.get('name')?.toString().trim() ?? '';
		if (!name) return fail(400, { error: 'Task name is required' });

		const { error: e } = await db()
			.from('vs_tasks')
			.update({
				name,
				description: form.get('description')?.toString().trim() || null,
				vp_reward: intOrZero(form.get('vp_reward')),
				pack_reward: form.get('pack_reward')?.toString().trim() || null
			})
			.eq('id', id)
			.eq('event_id', guard.ev.id);
		if (e) return fail(500, { error: e.message });
		return { ok: true };
	},

	// Delete an objective task. Fails gracefully if it already has submissions.
	deleteTask: async ({ locals, request, params }) => {
		if (!locals.user || !isAdmin(locals.user)) throw error(403, 'Not allowed');
		const guard = await requireTaskEvent(params.slug);
		if (guard.error) return guard.error;

		const form = await request.formData();
		const id = form.get('id')?.toString();
		if (!id) return fail(400, { error: 'Missing task id' });

		const { error: e } = await db()
			.from('vs_tasks')
			.delete()
			.eq('id', id)
			.eq('event_id', guard.ev.id);
		if (e) {
			return fail(400, { error: 'Could not delete — it likely has submissions already.' });
		}
		return { ok: true };
	},

	// Delete the whole event (only when it has no tasks left, to avoid orphaning
	// submissions). The UI surfaces this once tasks are cleared.
	deleteEvent: async ({ locals, params }) => {
		if (!locals.user || !isAdmin(locals.user)) throw error(403, 'Not allowed');
		const guard = await requireTaskEvent(params.slug);
		if (guard.error) return guard.error;

		const { count } = await db()
			.from('vs_tasks')
			.select('id', { count: 'exact', head: true })
			.eq('event_id', guard.ev.id);
		if ((count ?? 0) > 0) {
			return fail(400, { error: 'Remove all tasks before deleting the event.' });
		}

		const { error: e } = await db().from('vs_events').delete().eq('id', guard.ev.id);
		if (e) return fail(500, { error: e.message });
		throw redirect(303, '/admin/events');
	}
};

function form_status(form: FormData): string | null {
	const status = form.get('status')?.toString() ?? '';
	return ['draft', 'preview', 'open', 'locked', 'closed'].includes(status) ? status : null;
}
