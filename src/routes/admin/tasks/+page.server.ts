import { redirect, error, fail } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { isAdmin } from '$lib/server/auth';
import type { Actions, PageServerLoad } from './$types';

// The next Sunday at 00:00 UTC ("Sunday midnight"), strictly in the future — if
// today is Sunday it rolls to the following week, so a weekly task is ~a full week.
function nextSundayMidnightIso(): string {
	const now = new Date();
	const daysUntilSun = (7 - now.getUTCDay()) % 7 || 7; // Sun(0) → 7
	return new Date(
		Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + daysUntilSun)
	).toISOString();
}

// Admin task manager for vs_tasks: the weekly rotation POOL (templates) + the
// active task INSTANCES players submit to. Tasks are separate from full events
// (vs_events); see CLAUDE.md. isAdmin-gated.

function kindFromForm(v: FormDataEntryValue | null): 'weekly_task' | 'custom_task' {
	return v?.toString() === 'custom' ? 'custom_task' : 'weekly_task';
}

function intOrNull(v: FormDataEntryValue | null): number | null {
	const n = parseInt((v ?? '').toString(), 10);
	return Number.isFinite(n) ? n : null;
}

// Deadline for an activated task: an explicit `days` wins; a blank field defaults a
// WEEKLY task to Sunday midnight (the weekly reset — next Monday 00:00 UTC), like the
// old weekly post. Other kinds default to no deadline. An explicit 0 = no deadline.
function activationEndsAt(kind: string, daysField: FormDataEntryValue | null): string | null {
	const days = intOrNull(daysField);
	if (days && days > 0) return new Date(Date.now() + days * 86_400_000).toISOString();
	if (days === 0) return null;
	return kind === 'weekly_task' ? nextSundayMidnightIso() : null;
}

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) throw redirect(303, '/');
	if (!isAdmin(locals.user)) throw error(403, 'Not allowed');

	const sb = db();
	const [templatesRes, activeRes] = await Promise.all([
		sb
			.from('vs_tasks')
			.select('id, name, description, kind, vp_reward, pack_reward, in_rotation, created_at')
			.eq('is_template', true)
			.order('name', { ascending: true }),
		sb
			.from('vs_tasks')
			.select('id, name, description, kind, vp_reward, pack_reward, starts_at, ends_at, created_at')
			.eq('is_template', false)
			.eq('status', 'open')
			.order('created_at', { ascending: false })
	]);

	return {
		templates: templatesRes.data ?? [],
		active: activeRes.data ?? []
	};
};

export const actions: Actions = {
	// Create a task — either added to the rotation pool (template) or activated now.
	createTask: async ({ locals, request }) => {
		if (!locals.user || !isAdmin(locals.user)) throw error(403, 'Not allowed');

		const form = await request.formData();
		const name = form.get('name')?.toString().trim() ?? '';
		if (!name) return fail(400, { error: 'Name is required' });

		const description = form.get('description')?.toString().trim() || null;
		const kind = kindFromForm(form.get('kind'));
		const recurrence = kind === 'weekly_task' ? 'weekly' : 'one_off';
		const vp_reward = Math.max(0, intOrNull(form.get('vp_reward')) ?? 0);
		const pack_reward = form.get('pack_reward')?.toString().trim() || null;
		const mode = form.get('mode')?.toString() === 'active' ? 'active' : 'template';

		const base = {
			name,
			description,
			kind,
			recurrence,
			vp_reward,
			pack_reward,
			requires_proof: true
		};

		const row =
			mode === 'template'
				? { ...base, is_template: true, in_rotation: form.get('in_rotation') === 'on', status: 'open' }
				: {
						...base,
						is_template: false,
						in_rotation: false,
						status: 'open',
						starts_at: new Date().toISOString(),
						ends_at: activationEndsAt(kind, form.get('days'))
					};

		const { error: e } = await db().from('vs_tasks').insert(row);
		if (e) return fail(500, { error: e.message });
		return { ok: true };
	},

	// Toggle whether a template is eligible for the weekly auto-rotation.
	toggleRotation: async ({ locals, request }) => {
		if (!locals.user || !isAdmin(locals.user)) throw error(403, 'Not allowed');
		const form = await request.formData();
		const id = form.get('id')?.toString();
		if (!id) return fail(400, { error: 'Missing id' });
		const next = form.get('value')?.toString() === 'true';
		const { error: e } = await db()
			.from('vs_tasks')
			.update({ in_rotation: next })
			.eq('id', id)
			.eq('is_template', true);
		if (e) return fail(500, { error: e.message });
		return { ok: true };
	},

	// Spawn an active instance from a template (make it live now) AND pull the
	// template out of rotation so the same task isn't picked again (by an admin or
	// the bot's auto-rotation). Re-enable rotation on it later to cycle it back in.
	activateTemplate: async ({ locals, request }) => {
		if (!locals.user || !isAdmin(locals.user)) throw error(403, 'Not allowed');
		const form = await request.formData();
		const id = form.get('id')?.toString();
		if (!id) return fail(400, { error: 'Missing id' });

		const { data: t } = await db()
			.from('vs_tasks')
			.select('id, name, description, kind, recurrence, vp_reward, pack_reward, requires_proof')
			.eq('id', id)
			.eq('is_template', true)
			.maybeSingle();
		if (!t) return fail(404, { error: 'Template not found' });

		const { error: e } = await db().from('vs_tasks').insert({
			name: t.name,
			description: t.description,
			kind: t.kind,
			recurrence: t.recurrence,
			vp_reward: t.vp_reward,
			pack_reward: t.pack_reward,
			requires_proof: t.requires_proof,
			is_template: false,
			in_rotation: false,
			template_id: t.id,
			status: 'open',
			starts_at: new Date().toISOString(),
			ends_at: activationEndsAt(t.kind, form.get('days'))
		});
		if (e) return fail(500, { error: e.message });

		// Remove the template from the rotation pool so it isn't repeated.
		await db().from('vs_tasks').update({ in_rotation: false }).eq('id', t.id);

		return { ok: true };
	},

	// Edit a task's core fields (works for templates and active instances). The
	// active-task edit form also sends `days` to set the deadline: blank = leave the
	// deadline unchanged, 0 = no deadline, N = ends N days from now.
	updateTask: async ({ locals, request }) => {
		if (!locals.user || !isAdmin(locals.user)) throw error(403, 'Not allowed');
		const form = await request.formData();
		const id = form.get('id')?.toString();
		if (!id) return fail(400, { error: 'Missing id' });
		const name = form.get('name')?.toString().trim() ?? '';
		if (!name) return fail(400, { error: 'Name is required' });

		const patch: Record<string, unknown> = {
			name,
			description: form.get('description')?.toString().trim() || null,
			vp_reward: Math.max(0, intOrNull(form.get('vp_reward')) ?? 0),
			pack_reward: form.get('pack_reward')?.toString().trim() || null
		};

		if (form.has('days')) {
			const raw = (form.get('days')?.toString() ?? '').trim();
			if (raw !== '') {
				const n = parseInt(raw, 10);
				patch.ends_at = Number.isFinite(n) && n > 0 ? new Date(Date.now() + n * 86_400_000).toISOString() : null;
			}
		}

		const { error: e } = await db().from('vs_tasks').update(patch).eq('id', id);
		if (e) return fail(500, { error: e.message });
		return { ok: true };
	},

	// Close an active instance (deactivate it — stops showing/accepting submissions).
	closeTask: async ({ locals, request }) => {
		if (!locals.user || !isAdmin(locals.user)) throw error(403, 'Not allowed');
		const form = await request.formData();
		const id = form.get('id')?.toString();
		if (!id) return fail(400, { error: 'Missing id' });
		const { error: e } = await db()
			.from('vs_tasks')
			.update({ status: 'closed' })
			.eq('id', id)
			.eq('is_template', false);
		if (e) return fail(500, { error: e.message });
		return { ok: true };
	},

	// Delete a task. Fails (gracefully) if submissions reference it — close instead.
	deleteTask: async ({ locals, request }) => {
		if (!locals.user || !isAdmin(locals.user)) throw error(403, 'Not allowed');
		const form = await request.formData();
		const id = form.get('id')?.toString();
		if (!id) return fail(400, { error: 'Missing id' });
		const { error: e } = await db().from('vs_tasks').delete().eq('id', id);
		if (e) {
			return fail(400, {
				error: 'Could not delete — it likely has submissions. Close it instead.'
			});
		}
		return { ok: true };
	}
};
