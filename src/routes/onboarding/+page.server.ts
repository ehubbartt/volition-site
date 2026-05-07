import { redirect, fail } from '@sveltejs/kit';
import { z } from 'zod';
import { db } from '$lib/server/db';
import { isValidClan, CLAN_OPTIONS } from '$lib/clans';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = ({ locals }) => {
	if (!locals.user) throw redirect(303, '/');
	if (locals.user.rsn && locals.user.clan_allegiance) throw redirect(303, '/events');

	return {
		user: locals.user,
		clanOptions: CLAN_OPTIONS
	};
};

const RSN_REGEX = /^[A-Za-z0-9 _-]{1,12}$/;

const onboardingSchema = z.object({
	rsn: z.string().trim().regex(RSN_REGEX, 'RSN must be 1-12 chars (letters, numbers, space, _ or -)'),
	clan_allegiance: z.string().refine(isValidClan, 'Pick a clan')
});

export const actions: Actions = {
	default: async ({ request, locals }) => {
		if (!locals.user) throw redirect(303, '/');

		const form = await request.formData();
		const parsed = onboardingSchema.safeParse({
			rsn: form.get('rsn'),
			clan_allegiance: form.get('clan_allegiance')
		});

		if (!parsed.success) {
			return fail(400, {
				error: parsed.error.issues[0]?.message ?? 'Invalid input',
				rsn: form.get('rsn')?.toString() ?? '',
				clan_allegiance: form.get('clan_allegiance')?.toString() ?? ''
			});
		}

		const { rsn, clan_allegiance } = parsed.data;

		const supabase = db();

		const { data: collision } = await supabase
			.from('vs_users')
			.select('id')
			.ilike('rsn', rsn)
			.neq('id', locals.user.id)
			.maybeSingle();

		if (collision) {
			return fail(409, {
				error: 'That RSN is already registered to another account',
				rsn,
				clan_allegiance
			});
		}

		const { error } = await supabase
			.from('vs_users')
			.update({ rsn, clan_allegiance })
			.eq('id', locals.user.id);

		if (error) {
			return fail(500, { error: error.message, rsn, clan_allegiance });
		}

		throw redirect(303, '/events');
	}
};
