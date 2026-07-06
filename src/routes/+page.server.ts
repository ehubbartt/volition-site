import { error, fail } from '@sveltejs/kit';
import { z } from 'zod';
import { db } from '$lib/server/db';
import { isAdmin } from '$lib/server/auth';
import { CATEGORY_OPTIONS } from '$lib/calendar';
import type { Actions } from './$types';

// ACTIONS ONLY — the homepage has no server load. Its data comes from /api/home
// (see src/lib/server/homeData.ts) via the universal load in +page.ts, so
// navigating home never waits on the server. With no server load here, SvelteKit
// skips the data round-trip entirely on client-side navigation.

const CATEGORY_VALUES = CATEGORY_OPTIONS.map((c) => c.value) as [string, ...string[]];

const entrySchema = z.object({
	title: z.string().trim().min(1).max(120),
	description: z.string().trim().max(2000).optional().nullable(),
	starts_at: z.string().trim().min(1, 'Start date/time is required'),
	ends_at: z.string().trim().optional().nullable(),
	location: z.string().trim().max(120).optional().nullable(),
	link_url: z.string().trim().max(500).optional().nullable(),
	category: z.enum(CATEGORY_VALUES)
});

function normalizeDate(v: FormDataEntryValue | null): string | null {
	const s = v?.toString().trim();
	if (!s) return null;
	const d = new Date(s);
	if (Number.isNaN(d.getTime())) return null;
	return d.toISOString();
}

function parseEntry(form: FormData) {
	return entrySchema.safeParse({
		title: form.get('title'),
		description: form.get('description') || null,
		starts_at: form.get('starts_at'),
		ends_at: form.get('ends_at') || null,
		location: form.get('location') || null,
		link_url: form.get('link_url') || null,
		category: form.get('category') ?? 'event'
	});
}

export const actions: Actions = {
	createCalendarEntry: async ({ locals, request }) => {
		if (!locals.user || !isAdmin(locals.user)) throw error(403, 'Not allowed');

		const form = await request.formData();
		const parsed = parseEntry(form);
		if (!parsed.success) {
			return fail(400, { error: parsed.error.issues[0]?.message ?? 'Invalid input' });
		}

		const startsAt = normalizeDate(form.get('starts_at'));
		if (!startsAt) return fail(400, { error: 'Invalid start date/time' });

		const { error: insertError } = await db().from('vs_calendar_events').insert({
			title: parsed.data.title,
			description: parsed.data.description,
			starts_at: startsAt,
			ends_at: normalizeDate(form.get('ends_at')),
			location: parsed.data.location,
			link_url: parsed.data.link_url,
			category: parsed.data.category,
			created_by: locals.user.id
		});

		if (insertError) return fail(500, { error: insertError.message });
		return { ok: true, action: 'create' };
	},

	updateCalendarEntry: async ({ locals, request }) => {
		if (!locals.user || !isAdmin(locals.user)) throw error(403, 'Not allowed');

		const form = await request.formData();
		const id = form.get('id')?.toString();
		if (!id) return fail(400, { error: 'Missing id' });

		const parsed = parseEntry(form);
		if (!parsed.success) {
			return fail(400, { error: parsed.error.issues[0]?.message ?? 'Invalid input' });
		}

		const startsAt = normalizeDate(form.get('starts_at'));
		if (!startsAt) return fail(400, { error: 'Invalid start date/time' });

		const { error: updateError } = await db()
			.from('vs_calendar_events')
			.update({
				title: parsed.data.title,
				description: parsed.data.description,
				starts_at: startsAt,
				ends_at: normalizeDate(form.get('ends_at')),
				location: parsed.data.location,
				link_url: parsed.data.link_url,
				category: parsed.data.category,
				updated_at: new Date().toISOString()
			})
			.eq('id', id);

		if (updateError) return fail(500, { error: updateError.message });
		return { ok: true, action: 'update' };
	},

	deleteCalendarEntry: async ({ locals, request }) => {
		if (!locals.user || !isAdmin(locals.user)) throw error(403, 'Not allowed');

		const form = await request.formData();
		const id = form.get('id')?.toString();
		if (!id) return fail(400, { error: 'Missing id' });

		const { error: deleteError } = await db().from('vs_calendar_events').delete().eq('id', id);
		if (deleteError) return fail(500, { error: deleteError.message });
		return { ok: true, action: 'delete' };
	}
};
