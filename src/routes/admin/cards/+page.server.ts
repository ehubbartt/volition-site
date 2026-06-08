import { redirect, error, fail } from '@sveltejs/kit';
import { z } from 'zod';
import { db } from '$lib/server/db';
import { isCardTester } from '$lib/server/auth';
import { uploadCardFaces, uploadCardLayers, removeCardArt } from '$lib/server/cardArt';
import { isValidRarity, RARITIES, DEFAULT_RARITY, type CardAbility } from '$lib/cards/rarity';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) throw redirect(303, '/');
	if (!isCardTester(locals.user)) throw error(403, 'Not allowed');

	const [cardsRes, packsRes] = await Promise.all([
		db()
			.from('vs_cards')
			.select(
				'id, name, level, rarity, pack_id, abilities, flavor, front_path, front_url, back_path, back_url, layers, created_at'
			)
			.order('created_at', { ascending: false }),
		db()
			.from('vs_card_packs')
			.select(
				'id, name, description, cost_vp, cards_per_pack, released, rarity_weights, slot_weights, front_path, front_url, back_path, back_url, created_at'
			)
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
	cost_vp: z.coerce.number().int().min(0).max(10_000_000),
	cards_per_pack: z.coerce.number().int().min(1).max(50)
});

export const actions: Actions = {
	createCard: async ({ locals, request }) => {
		if (!locals.user || !isCardTester(locals.user)) throw error(403, 'Not allowed');

		const form = await request.formData();
		const parsed = cardSchema.safeParse({
			name: form.get('name'),
			level: form.get('level') || null,
			rarity: form.get('rarity') ?? DEFAULT_RARITY,
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

		const update: Record<string, unknown> = { ...faces.update };
		const cleanupPaths = [...faces.uploadedPaths];

		// Optional 3D depth layers (multi-file, bottom→top in upload order).
		const layerFiles = form.getAll('layer').filter((f): f is File => f instanceof File && f.size > 0);
		if (layerFiles.length) {
			const up = await uploadCardLayers(inserted.id, layerFiles);
			if ('error' in up) {
				for (const p of cleanupPaths) await removeCardArt(p);
				return fail(400, { error: `Card created, but layer upload failed: ${up.error}` });
			}
			update.layers = up.layers;
			cleanupPaths.push(...up.uploadedPaths);
		}

		if (Object.keys(update).length) {
			const { error: updErr } = await db().from('vs_cards').update(update).eq('id', inserted.id);
			if (updErr) {
				for (const p of cleanupPaths) await removeCardArt(p);
				return fail(500, { error: updErr.message });
			}
		}

		return { ok: true };
	},

	updateCard: async ({ locals, request }) => {
		if (!locals.user || !isCardTester(locals.user)) throw error(403, 'Not allowed');

		const form = await request.formData();
		const id = form.get('id')?.toString();
		if (!id) return fail(400, { error: 'Missing id' });

		const parsed = cardSchema.safeParse({
			name: form.get('name'),
			level: form.get('level') || null,
			rarity: form.get('rarity') ?? DEFAULT_RARITY,
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

		// Snapshot old paths so we can delete any face/layer that gets replaced.
		const { data: prev } = await db()
			.from('vs_cards')
			.select('front_path, back_path, layers')
			.eq('id', id)
			.maybeSingle();

		const faces = await uploadCardFaces('cards', id, form);
		if ('error' in faces) return fail(400, { error: faces.error });
		Object.assign(update, faces.update);

		// 3D depth layers: the "clear" toggle empties them; otherwise uploading any
		// layer files REPLACES the whole set (bottom→top in upload order).
		const clearLayers = form.get('clear_layers') === 'on';
		const layerFiles = form.getAll('layer').filter((f): f is File => f instanceof File && f.size > 0);
		let replacedLayers = false;
		if (clearLayers) {
			update.layers = [];
			replacedLayers = true;
		} else if (layerFiles.length) {
			const up = await uploadCardLayers(id, layerFiles);
			if ('error' in up) {
				for (const p of faces.uploadedPaths) await removeCardArt(p);
				return fail(400, { error: up.error });
			}
			update.layers = up.layers;
			replacedLayers = true;
		}

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
		// Old layer files are orphaned once layers are replaced/cleared — delete them.
		if (replacedLayers && Array.isArray(prev?.layers)) {
			for (const l of prev.layers as { path?: string }[]) await removeCardArt(l?.path);
		}

		return { ok: true };
	},

	deleteCard: async ({ locals, request }) => {
		if (!locals.user || !isCardTester(locals.user)) throw error(403, 'Not allowed');

		const form = await request.formData();
		const id = form.get('id')?.toString();
		if (!id) return fail(400, { error: 'Missing id' });

		const { data: existing } = await db()
			.from('vs_cards')
			.select('front_path, back_path, layers')
			.eq('id', id)
			.maybeSingle();

		const { error: delErr } = await db().from('vs_cards').delete().eq('id', id);
		if (delErr) return fail(500, { error: delErr.message });

		await removeCardArt(existing?.front_path as string | null);
		await removeCardArt(existing?.back_path as string | null);
		if (Array.isArray(existing?.layers)) {
			for (const l of existing.layers as { path?: string }[]) await removeCardArt(l?.path);
		}

		return { ok: true };
	},

	createPack: async ({ locals, request }) => {
		if (!locals.user || !isCardTester(locals.user)) throw error(403, 'Not allowed');

		const form = await request.formData();
		const parsed = packSchema.safeParse({
			name: form.get('name'),
			description: form.get('description') || null,
			cost_vp: form.get('cost_vp') ?? '0',
			cards_per_pack: form.get('cards_per_pack') ?? '5'
		});
		if (!parsed.success) {
			return fail(400, { error: parsed.error.issues[0]?.message ?? 'Invalid input' });
		}

		const { data: inserted, error: insErr } = await db()
			.from('vs_card_packs')
			.insert({
				name: parsed.data.name,
				description: parsed.data.description,
				cost_vp: parsed.data.cost_vp,
				cards_per_pack: parsed.data.cards_per_pack,
				released: form.get('released') === 'on'
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
		if (!locals.user || !isCardTester(locals.user)) throw error(403, 'Not allowed');

		const form = await request.formData();
		const id = form.get('id')?.toString();
		if (!id) return fail(400, { error: 'Missing id' });

		const parsed = packSchema.safeParse({
			name: form.get('name'),
			description: form.get('description') || null,
			cost_vp: form.get('cost_vp') ?? '0',
			cards_per_pack: form.get('cards_per_pack') ?? '5'
		});
		if (!parsed.success) {
			return fail(400, { error: parsed.error.issues[0]?.message ?? 'Invalid input' });
		}

		// Per-slot drop weights: one rarity-weight map per slot, indexed 0..n-1
		// (n = cards_per_pack). Fields arrive as slot_<i>_weight_<rarity>. Only
		// positive weights are kept; an empty slot map falls back to the legacy
		// per-pack rarity_weights (left untouched here) at roll time.
		const slotWeights: Record<string, number>[] = [];
		for (let i = 0; i < parsed.data.cards_per_pack; i++) {
			const slot: Record<string, number> = {};
			for (const r of RARITIES) {
				const v = Number(form.get(`slot_${i}_weight_${r.key}`) ?? 0);
				if (Number.isFinite(v) && v > 0) slot[r.key] = v;
			}
			slotWeights.push(slot);
		}

		const update: Record<string, unknown> = {
			name: parsed.data.name,
			description: parsed.data.description,
			cost_vp: parsed.data.cost_vp,
			cards_per_pack: parsed.data.cards_per_pack,
			slot_weights: slotWeights,
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

	toggleRelease: async ({ locals, request }) => {
		if (!locals.user || !isCardTester(locals.user)) throw error(403, 'Not allowed');

		const form = await request.formData();
		const id = form.get('id')?.toString();
		if (!id) return fail(400, { error: 'Missing id' });

		const { data: prev, error: readErr } = await db()
			.from('vs_card_packs')
			.select('released')
			.eq('id', id)
			.maybeSingle();
		if (readErr) return fail(500, { error: readErr.message });
		if (!prev) return fail(404, { error: 'Pack not found' });

		const { error: updErr } = await db()
			.from('vs_card_packs')
			.update({ released: !prev.released, updated_at: new Date().toISOString() })
			.eq('id', id);
		if (updErr) return fail(500, { error: updErr.message });

		return { ok: true };
	},

	deletePack: async ({ locals, request }) => {
		if (!locals.user || !isCardTester(locals.user)) throw error(403, 'Not allowed');

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
