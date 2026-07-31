import { redirect, fail } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { isAdmin } from '$lib/server/auth';
import { createBattleship, BATTLESHIP_KIND } from '$lib/server/battleship';
import { DEFAULT_TIERS } from '$lib/battleship/rules';
import type { Actions, PageServerLoad } from './$types';

// Battleship game list + creation. Form-heavy and rare, so it keeps a classic server
// load rather than the instant-nav pattern (see docs/PAGES.md).

function slugify(name: string): string {
	return name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 60);
}

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) throw redirect(303, '/');
	if (!isAdmin(locals.user)) throw redirect(303, '/');

	const { data } = await db()
		.from('vs_events')
		.select('id, slug, name, status, structure, unlisted, created_at, signup_opens_at, signup_closes_at')
		.eq('kind', BATTLESHIP_KIND)
		.order('created_at', { ascending: false });

	const games = (data ?? []).map((row) => {
		const ev = row as unknown as {
			id: string; slug: string; name: string; status: string; unlisted: boolean;
			created_at: string; signup_opens_at: string | null; signup_closes_at: string | null;
			structure: { battleship?: { phase?: string; winner?: number | null; test?: boolean } } | null;
		};
		return {
			id: ev.id,
			slug: ev.slug,
			name: ev.name,
			status: ev.status,
			unlisted: ev.unlisted,
			createdAt: ev.created_at,
			signupOpensAt: ev.signup_opens_at,
			signupClosesAt: ev.signup_closes_at,
			phase: ev.structure?.battleship?.phase ?? 'setup',
			winner: ev.structure?.battleship?.winner ?? null,
			test: ev.structure?.battleship?.test ?? false
		};
	});

	return { games, defaultTiers: DEFAULT_TIERS };
};

export const actions: Actions = {
	create: async ({ locals, request }) => {
		if (!locals.user || !isAdmin(locals.user)) return fail(403, { error: 'Admins only' });
		const form = await request.formData();
		const name = form.get('name')?.toString().trim() ?? '';
		if (!name) return fail(400, { error: 'Give the event a name' });

		const slug = slugify(form.get('slug')?.toString().trim() || name);
		if (!slug) return fail(400, { error: 'That name has no usable slug — add some letters' });

		const { data: clash } = await db().from('vs_events').select('id').eq('slug', slug).maybeSingle();
		if (clash) return fail(400, { error: `The slug "${slug}" is already taken` });

		const tiers = DEFAULT_TIERS.map((t, i) => {
			const raw = form.get(`tier_${i}`)?.toString().trim();
			const v = raw ? Number(raw.replace(/[_,\s]/g, '')) : NaN;
			return Number.isFinite(v) && v > 0 ? { ...t, min_value: Math.round(v) } : t;
		});
		// Ascending floors, or tierForValue picks a nonsense tier.
		for (let i = 1; i < tiers.length; i++) {
			if (tiers[i].min_value <= tiers[i - 1].min_value) {
				return fail(400, { error: 'Each bomb tier needs a higher value than the one before it' });
			}
		}

		const sizeRaw = form.get('size')?.toString().trim();
		const size = sizeRaw ? Number(sizeRaw) : undefined;
		if (sizeRaw && (!Number.isFinite(size) || size! < 8 || size! > 20)) {
			return fail(400, { error: 'Board size has to be between 8 and 20 (leave it blank to scale with signups)' });
		}

		const placementRaw = form.get('placement_minutes')?.toString().trim();
		const placementMinutes = placementRaw ? Number(placementRaw) : undefined;
		if (placementRaw && (!Number.isFinite(placementMinutes) || placementMinutes! < 1)) {
			return fail(400, { error: 'The placement window has to be at least a minute' });
		}

		const res = await createBattleship({
			slug,
			name,
			description: form.get('description')?.toString().trim() || null,
			signupOpensAt: form.get('signup_opens_at')?.toString() || null,
			signupClosesAt: form.get('signup_closes_at')?.toString() || null,
			ownerUserId: locals.user.id,
			size,
			tiers,
			placementMinutes,
			test: form.get('test') === 'on',
			unlisted: form.get('unlisted') === 'on'
		});
		if (!res.ok) return fail(400, { error: res.error });
		throw redirect(303, `/admin/battleship/${slug}`);
	},

	remove: async ({ locals, request }) => {
		if (!locals.user || !isAdmin(locals.user)) return fail(403, { error: 'Admins only' });
		const form = await request.formData();
		const id = form.get('id')?.toString() ?? '';
		if (!id) return fail(400, { error: 'No game given' });

		const sb = db();
		const { data: ev } = await sb.from('vs_events').select('id, structure').eq('id', id).maybeSingle();
		const isTest = (ev as { structure?: { battleship?: { test?: boolean } } } | null)?.structure?.battleship?.test;
		// Only test games are deletable from here. A real event with real drops behind it
		// gets archived through /admin/events like every other event.
		if (!isTest) return fail(400, { error: 'Only test games can be deleted here — close a real event from Events instead' });

		// Signups and teams don't cascade from the event row; drop them first.
		await sb.from('vs_event_signups').delete().eq('event_id', id);
		await sb.from('vs_teams').delete().eq('event_id', id);
		const { error } = await sb.from('vs_events').delete().eq('id', id);
		return error ? fail(400, { error: error.message }) : { ok: true };
	}
};
