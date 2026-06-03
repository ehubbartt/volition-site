import { redirect, error, fail } from '@sveltejs/kit';
import { z } from 'zod';
import { db } from '$lib/server/db';
import { isAdmin } from '$lib/server/auth';
import { uploadCardFaces, removeCardArt } from '$lib/server/cardArt';
import { isValidRarity, type CardAbility } from '$lib/cards/rarity';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) throw redirect(303, '/');
	if (!isAdmin(locals.user)) throw error(403, 'Not allowed');

	const [cardsRes, packsRes] = await Promise.all([
		db()
			.from('vs_cards')
			.select(
				'id, name, level, rarity, pack_id, abilities, flavor, front_path, front_url, back_path, back_url, created_at'
			)
			.order('created_at', { ascending: false }),
		db()
			.from('vs_card_packs')
			.select('id, name, description, cost_vp, front_path, front_url, back_path, back_url, created_at')
			.order('created_at', { ascending: false })
	]);

	if (cardsRes.error) throw error(500, cardsRes.error.message);
	if (packsRes.error) throw error(500, packsRes.error.message);

	return { cards: cardsRes.data ?? [], packs: packsRes.data ?? [] };
};

/* ------------------------------- Cards ------------------------------- */

const cardSchema = z.object({
	name: z.string().trim().min(1, 'Name is required').max(120),
	level: z.coerce.number().int().min(0).max(100000).nullable(),
	rarity: z.string().refine(isValidRarity, 'Pick a rarity'),
	pack_id: z.string().uuid('Pick a set/pack for this card'),
	flavor: z.string().trim().max(2000).optional().nullable()
});

// Abilities arrive as parallel ability_name[] / ability_desc[] fields.
function parseAbilities(form: FormData): CardAbility[] {
	const names = form.getAll('ability_name').map((v) => v.toString().trim());
	const descs = form.getAll('ability_desc').map((v) => v.toString().trim());
	const out: CardAbility[] = [];
	for (let i = 0; i < names.length; i++) {
		if (names[i]) out.push({ name: names[i], description: descs[i] ?? '' });
	}
	return out;
}

/* ------------------------------- Packs ------------------------------- */

const packSchema = z.object({
	name: z.string().trim().min(1, 'Name is required').max(120),
	description: z.string().trim().max(2000).optional().nullable(),
	cost_vp: z.coerce.number().int().min(0).max(10_000_000)
});

export const actions: Actions = {
	createCard: async ({ locals, request }) => {
		if (!locals.user || !isAdmin(locals.user)) throw error(403, 'Not allowed');

		const form = await request.formData();
		const parsed = cardSchema.safeParse({
			name: form.get('name'),
			level: form.get('level') || null,
			rarity: form.get('rarity') ?? 'common',
			pack_id: form.get('pack_id') ?? '',
			flavor: form.get('flavor') || null
		});
		if (!parsed.success) {
			return fail(400, { error: parsed.error.issues[0]?.message ?? 'Invalid input' });
		}

		const abilities = parseAbilities(form);

		const { data: inserted, error: insErr } = await db()
			.from('vs_cards')
			.insert({
				name: parsed.data.name,
				level: parsed.data.level,
				rarity: parsed.data.rarity,
				pack_id: parsed.data.pack_id,
				flavor: parsed.data.flavor,
				abilities
			})
			.select('id')
			.single();

		if (insErr || !inserted) return fail(500, { error: insErr?.message ?? 'Insert failed' });

		const faces = await uploadCardFaces('cards', inserted.id, form);
		if ('error' in faces) {
			// Card row exists but art failed — report so the admin can retry.
			return fail(400, { error: `Card created, but art upload failed: ${faces.error}` });
		}
		if (Object.keys(faces.update).length) {
			const { error: updErr } = await db()
				.from('vs_cards')
				.update(faces.update)
				.eq('id', inserted.id);
			if (updErr) {
				for (const p of faces.uploadedPaths) await removeCardArt(p);
				return fail(500, { error: updErr.message });
			}
		}

		return { ok: true };
	},

	updateCard: async ({ locals, request }) => {
		if (!locals.user || !isAdmin(locals.user)) throw error(403, 'Not allowed');

		const form = await request.formData();
		const id = form.get('id')?.toString();
		if (!id) return fail(400, { error: 'Missing id' });

		const parsed = cardSchema.safeParse({
			name: form.get('name'),
			level: form.get('level') || null,
			rarity: form.get('rarity') ?? 'common',
			pack_id: form.get('pack_id') ?? '',
			flavor: form.get('flavor') || null
		});
		if (!parsed.success) {
			return fail(400, { error: parsed.error.issues[0]?.message ?? 'Invalid input' });
		}

		const abilities = parseAbilities(form);

		const update: Record<string, unknown> = {
			name: parsed.data.name,
			level: parsed.data.level,
			rarity: parsed.data.rarity,
			pack_id: parsed.data.pack_id,
			flavor: parsed.data.flavor,
			abilities,
			updated_at: new Date().toISOString()
		};

		// Snapshot old paths so we can delete any face that gets replaced.
		const { data: prev } = await db()
			.from('vs_cards')
			.select('front_path, back_path')
			.eq('id', id)
			.maybeSingle();

		const faces = await uploadCardFaces('cards', id, form);
		if ('error' in faces) return fail(400, { error: faces.error });
		Object.assign(update, faces.update);

		const { error: updErr } = await db().from('vs_cards').update(update).eq('id', id);
		if (updErr) {
			for (const p of faces.uploadedPaths) await removeCardArt(p);
			return fail(500, { error: updErr.message });
		}

		if (faces.update.front_path && prev?.front_path && prev.front_path !== faces.update.front_path) {
			await removeCardArt(prev.front_path as string);
		}
		if (faces.update.back_path && prev?.back_path && prev.back_path !== faces.update.back_path) {
			await removeCardArt(prev.back_path as string);
		}

		return { ok: true };
	},

	deleteCard: async ({ locals, request }) => {
		if (!locals.user || !isAdmin(locals.user)) throw error(403, 'Not allowed');

		const form = await request.formData();
		const id = form.get('id')?.toString();
		if (!id) return fail(400, { error: 'Missing id' });

		const { data: existing } = await db()
			.from('vs_cards')
			.select('front_path, back_path')
			.eq('id', id)
			.maybeSingle();

		const { error: delErr } = await db().from('vs_cards').delete().eq('id', id);
		if (delErr) return fail(500, { error: delErr.message });

		await removeCardArt(existing?.front_path as string | null);
		await removeCardArt(existing?.back_path as string | null);

		return { ok: true };
	},

	createPack: async ({ locals, request }) => {
		if (!locals.user || !isAdmin(locals.user)) throw error(403, 'Not allowed');

		const form = await request.formData();
		const parsed = packSchema.safeParse({
			name: form.get('name'),
			description: form.get('description') || null,
			cost_vp: form.get('cost_vp') ?? '0'
		});
		if (!parsed.success) {
			return fail(400, { error: parsed.error.issues[0]?.message ?? 'Invalid input' });
		}

		const { data: inserted, error: insErr } = await db()
			.from('vs_card_packs')
			.insert({
				name: parsed.data.name,
				description: parsed.data.description,
				cost_vp: parsed.data.cost_vp
			})
			.select('id')
			.single();

		if (insErr || !inserted) return fail(500, { error: insErr?.message ?? 'Insert failed' });

		const faces = await uploadCardFaces('packs', inserted.id, form);
		if ('error' in faces) {
			return fail(400, { error: `Pack created, but art upload failed: ${faces.error}` });
		}
		if (Object.keys(faces.update).length) {
			const { error: updErr } = await db()
				.from('vs_card_packs')
				.update(faces.update)
				.eq('id', inserted.id);
			if (updErr) {
				for (const p of faces.uploadedPaths) await removeCardArt(p);
				return fail(500, { error: updErr.message });
			}
		}

		return { ok: true };
	},

	updatePack: async ({ locals, request }) => {
		if (!locals.user || !isAdmin(locals.user)) throw error(403, 'Not allowed');

		const form = await request.formData();
		const id = form.get('id')?.toString();
		if (!id) return fail(400, { error: 'Missing id' });

		const parsed = packSchema.safeParse({
			name: form.get('name'),
			description: form.get('description') || null,
			cost_vp: form.get('cost_vp') ?? '0'
		});
		if (!parsed.success) {
			return fail(400, { error: parsed.error.issues[0]?.message ?? 'Invalid input' });
		}

		const update: Record<string, unknown> = {
			name: parsed.data.name,
			description: parsed.data.description,
			cost_vp: parsed.data.cost_vp,
			updated_at: new Date().toISOString()
		};

		const { data: prev } = await db()
			.from('vs_card_packs')
			.select('front_path, back_path')
			.eq('id', id)
			.maybeSingle();

		const faces = await uploadCardFaces('packs', id, form);
		if ('error' in faces) return fail(400, { error: faces.error });
		Object.assign(update, faces.update);

		const { error: updErr } = await db().from('vs_card_packs').update(update).eq('id', id);
		if (updErr) {
			for (const p of faces.uploadedPaths) await removeCardArt(p);
			return fail(500, { error: updErr.message });
		}

		if (faces.update.front_path && prev?.front_path && prev.front_path !== faces.update.front_path) {
			await removeCardArt(prev.front_path as string);
		}
		if (faces.update.back_path && prev?.back_path && prev.back_path !== faces.update.back_path) {
			await removeCardArt(prev.back_path as string);
		}

		return { ok: true };
	},

	deletePack: async ({ locals, request }) => {
		if (!locals.user || !isAdmin(locals.user)) throw error(403, 'Not allowed');

		const form = await request.formData();
		const id = form.get('id')?.toString();
		if (!id) return fail(400, { error: 'Missing id' });

		const { data: existing } = await db()
			.from('vs_card_packs')
			.select('front_path, back_path')
			.eq('id', id)
			.maybeSingle();

		const { error: delErr } = await db().from('vs_card_packs').delete().eq('id', id);
		if (delErr) return fail(500, { error: delErr.message });

		await removeCardArt(existing?.front_path as string | null);
		await removeCardArt(existing?.back_path as string | null);

		return { ok: true };
	}
};
