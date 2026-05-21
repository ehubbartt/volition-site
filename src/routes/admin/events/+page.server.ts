import { redirect, error, fail } from '@sveltejs/kit';
import { z } from 'zod';
import { db } from '$lib/server/db';
import { isAdmin } from '$lib/server/auth';
import { markdownPreview } from '$lib/markdown';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) throw redirect(303, '/');
	if (!isAdmin(locals.user)) throw error(403, 'Not allowed');

	const { data: events, error: queryError } = await db()
		.from('vs_events')
		.select(
			'id, slug, name, description, status, signup_opens_at, signup_closes_at, starts_at, ends_at, team_size, created_at'
		)
		.order('created_at', { ascending: false });

	if (queryError) throw error(500, queryError.message);

	return {
		events: (events ?? []).map((ev) => ({
			...ev,
			description_preview: markdownPreview(ev.description, 200)
		}))
	};
};

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
	}
};
