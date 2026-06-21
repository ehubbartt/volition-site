import { redirect, error, fail } from '@sveltejs/kit';
import { z } from 'zod';
import { db, fetchAllFiltered } from '$lib/server/db';
import { isCardTester, isCardAdmin } from '$lib/server/auth';
import {
	uploadCardFaces,
	uploadCardLayers,
	uploadCardSound,
	uploadCardModel,
	removeCardArt,
	type UploadedLayer
} from '$lib/server/cardArt';
import { grantUserPack } from '$lib/server/gamba';
import { isValidRarity, RARITIES, DEFAULT_RARITY, type CardAbility } from '$lib/cards/rarity';
import { isLayerEffect, type LayerEffect } from '$lib/cards/layerEffects';
import { MAX_CARD_LAYERS } from '$lib/cards/config';
import type { Actions, PageServerLoad } from './$types';

// Cap on a single manual pack grant (the "Grant" tab).
const MAX_QTY = 100;

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) throw redirect(303, '/');
	// Admins may VIEW (read-only editors + the grant/test tools); only card testers
	// can create/edit/delete the catalog (canEdit gates the editing UI + write actions).
	if (!isCardAdmin(locals.user)) throw error(403, 'Not allowed');
	const canEdit = isCardTester(locals.user);

	const [cardsRes, packsRes, membersRes] = await Promise.all([
		db()
			.from('vs_cards')
			.select(
				'id, name, level, rarity, pack_id, abilities, flavor, front_path, front_url, back_path, back_url, holo_path, holo_url, holo_border, sound_path, sound_url, model_path, model_url, model_settings, models, layers, full_art, created_at'
			)
			.order('created_at', { ascending: false }),
		db()
			.from('vs_card_packs')
			.select(
				'id, name, description, cost_vp, cost_gp, discount_pct, discount_vp_pct, cards_per_pack, released, weekly_free, rarity_weights, slot_weights, slot_finishes, front_path, front_url, back_path, back_url, holo_regular_path, holo_regular_url, holo_reverse_path, holo_reverse_url, created_at'
			)
			.order('created_at', { ascending: false }),
		// Grant tab: every member with a site profile (the only grantable targets —
		// vs_user_packs.user_id FKs vs_users, so bot-roster-only members can't receive).
		// Paginate: site members exceed the 1000-row cap. (vs_cards/vs_card_packs are an
		// admin catalog of hundreds — well under the raised max_rows backstop — left as-is.)
		fetchAllFiltered((f, t) =>
			db().from('vs_users').select('id, rsn, discord_username').order('rsn', { ascending: true }).range(f, t)
		)
	]);

	if (cardsRes.error) throw error(500, cardsRes.error.message);
	if (packsRes.error) throw error(500, packsRes.error.message);
	if (membersRes.error) throw error(500, membersRes.error.message);

	const members = (membersRes.data ?? []) as { id: string; rsn: string | null; discord_username: string | null }[];
	return { cards: cardsRes.data ?? [], packs: packsRes.data ?? [], members, canEdit };
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

const FRONT_AXES = ['+x', '-x', '+y', '-y', '+z', '-z'];

// Sanitize one model's placement settings posted by the visual builder.
function sanitizeModelSettings(raw: unknown) {
	const o = (raw ?? {}) as Record<string, unknown>;
	const num = (k: string, d: number) => {
		const n = Number(o[k]);
		return Number.isFinite(n) ? n : d;
	};
	return {
		scale: num('scale', 1),
		offsetX: num('offsetX', 0),
		offsetY: num('offsetY', 0),
		offsetZ: num('offsetZ', 0),
		rotX: num('rotX', 0),
		rotY: num('rotY', 0),
		rotZ: num('rotZ', 0),
		spin: num('spin', 0),
		animate: o.animate !== false,
		clip: o.clip === true,
		faceCamera: o.faceCamera === true,
		wander: o.wander === true,
		wanderSpeed: num('wanderSpeed', 0.5),
		frontAxis: FRONT_AXES.includes(String(o.frontAxis)) ? String(o.frontAxis) : '+z'
	};
}

// Sanitize the full models array (builder save). Keeps `path` (for cleanup) + `url`.
function sanitizeModels(raw: unknown) {
	if (!Array.isArray(raw)) return [];
	return raw
		.filter((e) => e && typeof (e as { url?: unknown }).url === 'string')
		.map((e) => {
			const o = e as Record<string, unknown>;
			return {
				path: typeof o.path === 'string' ? o.path : null,
				url: o.url as string,
				settings: sanitizeModelSettings(o.settings)
			};
		});
}

/* ------------------------------- Packs ------------------------------- */

const packSchema = z.object({
	name: z.string().trim().min(1, 'Name is required').max(120),
	description: z.string().trim().max(2000).optional().nullable(),
	cost_vp: z.coerce.number().int().min(0).max(10_000_000),
	discount_pct: z.coerce.number().int().min(0).max(100),
	discount_vp_pct: z.coerce.number().int().min(0).max(100),
	cards_per_pack: z.coerce.number().int().min(1).max(50)
});

// GP price is optional/nullable (empty or 0 = not buyable with GP). Parsed outside the
// schema so a blank field stays NULL rather than coercing to 0.
function parsePackGp(form: FormData): number | null {
	const raw = form.get('cost_gp')?.toString().trim();
	if (!raw) return null;
	const n = Math.floor(Number(raw));
	return Number.isFinite(n) && n > 0 ? n : null;
}

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
				abilities,
				full_art: form.get('full_art') === 'on',
				holo_border: form.get('holo_border') === 'on'
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

		// Optional 3D depth layers (multi-file, bottom→top in upload order). Effects
		// can be assigned afterwards via the per-layer dropdowns in the Edit form.
		const layerFiles = form.getAll('layer').filter((f): f is File => f instanceof File && f.size > 0);
		if (layerFiles.length) {
			const layerEffects = form.getAll('layer_effect').map((v) => v.toString());
			const up = await uploadCardLayers(inserted.id, layerFiles, layerEffects);
			if ('error' in up) {
				for (const p of cleanupPaths) await removeCardArt(p);
				return fail(400, { error: `Card created, but layer upload failed: ${up.error}` });
			}
			update.layers = up.layers;
			cleanupPaths.push(...up.uploadedPaths);
		}

		// Optional open sound.
		const soundFile = form.get('sound');
		if (soundFile instanceof File && soundFile.size > 0) {
			const up = await uploadCardSound(inserted.id, soundFile);
			if ('error' in up) {
				for (const p of cleanupPaths) await removeCardArt(p);
				return fail(400, { error: `Card created, but sound upload failed: ${up.error}` });
			}
			update.sound_path = up.path;
			update.sound_url = up.url;
			cleanupPaths.push(up.path);
		}

		// Optional 3D model(s) (.glb) — each becomes a `models` entry (placed later in the
		// builder). Multiple files allowed.
		const modelFiles = form.getAll('model').filter((f): f is File => f instanceof File && f.size > 0);
		if (modelFiles.length) {
			const models: { path: string; url: string; settings: object }[] = [];
			for (const f of modelFiles) {
				const up = await uploadCardModel(inserted.id, f);
				if ('error' in up) {
					for (const p of cleanupPaths) await removeCardArt(p);
					return fail(400, { error: `Card created, but model upload failed: ${up.error}` });
				}
				models.push({ path: up.path, url: up.url, settings: {} });
				cleanupPaths.push(up.path);
			}
			update.models = models;
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
			full_art: form.get('full_art') === 'on',
			holo_border: form.get('holo_border') === 'on',
			updated_at: new Date().toISOString()
		};

		// Snapshot old paths so we can delete any face/layer/model that gets replaced.
		const { data: prev } = await db()
			.from('vs_cards')
			.select('front_path, back_path, holo_path, sound_path, model_path, models, layers')
			.eq('id', id)
			.maybeSingle();

		const faces = await uploadCardFaces('cards', id, form);
		if ('error' in faces) return fail(400, { error: faces.error });
		Object.assign(update, faces.update);

		// Open sound: a "remove" toggle clears it; uploading a new file replaces it.
		const removeSound = form.get('remove_sound') === 'on';
		const soundFile = form.get('sound');
		let newSoundPath: string | null = null;
		if (soundFile instanceof File && soundFile.size > 0) {
			const up = await uploadCardSound(id, soundFile);
			if ('error' in up) {
				for (const p of faces.uploadedPaths) await removeCardArt(p);
				return fail(400, { error: up.error });
			}
			update.sound_path = up.path;
			update.sound_url = up.url;
			newSoundPath = up.path;
		} else if (removeSound) {
			update.sound_path = null;
			update.sound_url = null;
		}

		// 3D models: "remove all" clears them; uploading new .glb(s) APPENDS them (placed
		// later in the builder). Per-model placement + per-model delete is done in the
		// builder (updateModels action). Newly-uploaded entries start with default settings.
		const prevModels = (Array.isArray(prev?.models) ? prev.models : []) as {
			path?: string;
			url: string;
			settings?: unknown;
		}[];
		const removeModels = form.get('remove_models') === 'on';
		const modelFiles = form.getAll('model').filter((f): f is File => f instanceof File && f.size > 0);
		let modelsCleared = false;
		if (removeModels) {
			update.models = [];
			update.model_url = null;
			update.model_path = null;
			update.model_settings = null;
			modelsCleared = true;
		} else if (modelFiles.length) {
			const added: { path: string; url: string; settings: object }[] = [];
			for (const f of modelFiles) {
				const up = await uploadCardModel(id, f);
				if ('error' in up) {
					for (const p of faces.uploadedPaths) await removeCardArt(p);
					return fail(400, { error: up.error });
				}
				added.push({ path: up.path, url: up.url, settings: {} });
			}
			update.models = [...prevModels, ...added];
		}

		// Remove the full-art holo image (clears it; a new upload replaces instead).
		const removeHolo = form.get('remove_holo') === 'on';
		if (removeHolo && !faces.update.holo_path) {
			update.holo_path = null;
			update.holo_url = null;
		}

		// 3D depth layers — managed individually by the edit drawer. `layers_json` is the
		// ordered list of KEPT existing layers ({path,url,effect,depth,inset}); files in
		// `layer` are NEW layers appended after them (with parallel new_layer_* metadata).
		// Any prior layer file not in the final set is an orphan to delete. Absent
		// layers_json = leave layers untouched (e.g. the simple create-form path).
		const prevLayerPaths = Array.isArray(prev?.layers)
			? (prev.layers as { path?: string }[]).map((l) => l?.path).filter((p): p is string => !!p)
			: [];
		let finalLayerPaths: string[] | null = null; // null = layers untouched
		const layersJson = form.get('layers_json');
		if (typeof layersJson === 'string') {
			// Each entry is either an EXISTING layer (has url/path) or a placeholder for a
			// NEW file ({new:true}); the `layer` files fill the new slots left→right, so the
			// final order matches the drawer exactly (existing + new can interleave).
			let entries: {
				new?: boolean;
				path?: string;
				url?: string;
				effect?: unknown;
				depth?: unknown;
				inset?: unknown;
			}[] = [];
			try {
				const parsed = JSON.parse(layersJson);
				if (Array.isArray(parsed)) entries = parsed;
			} catch {
				return fail(400, { error: 'Bad layers data' });
			}

			const keepCount = entries.filter((e) => e && (e.new === true || typeof e.url === 'string')).length;
			if (keepCount > MAX_CARD_LAYERS) {
				for (const p of faces.uploadedPaths) await removeCardArt(p);
				return fail(400, { error: `Too many layers (max ${MAX_CARD_LAYERS})` });
			}

			// Upload the new files (in order); they map onto the {new:true} slots.
			const newFiles = form.getAll('layer').filter((f): f is File => f instanceof File && f.size > 0);
			let uploaded: UploadedLayer[] = [];
			if (newFiles.length) {
				const fx = form.getAll('new_layer_effect').map((v) => v.toString());
				const dp = form.getAll('new_layer_depth').map((v) => Number(v.toString()));
				const ins = form.getAll('new_layer_inset').map((v) => v.toString() === 'true');
				const up = await uploadCardLayers(id, newFiles, fx, dp, ins, prevLayerPaths.length);
				if ('error' in up) {
					for (const p of faces.uploadedPaths) await removeCardArt(p);
					return fail(400, { error: up.error });
				}
				uploaded = up.layers;
			}

			let ni = 0;
			const finalLayers: UploadedLayer[] = [];
			for (const e of entries) {
				if (e && e.new === true) {
					const u = uploaded[ni++];
					if (u) finalLayers.push(u);
				} else if (e && typeof e.url === 'string') {
					finalLayers.push({
						path: typeof e.path === 'string' ? e.path : e.url,
						url: e.url,
						effect: isLayerEffect(e.effect) ? (e.effect as LayerEffect) : null,
						depth: typeof e.depth === 'number' && Number.isFinite(e.depth) ? e.depth : null,
						inset: e.inset === true
					});
				}
			}
			update.layers = finalLayers;
			finalLayerPaths = finalLayers.map((l) => l.path).filter((p): p is string => !!p);
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
		// Holo image replaced or cleared → delete the old file.
		if (prev?.holo_path && (faces.update.holo_path || removeHolo) && prev.holo_path !== faces.update.holo_path) {
			await removeCardArt(prev.holo_path as string);
		}
		// Sound replaced or cleared → delete the old file.
		if (prev?.sound_path && (newSoundPath || removeSound) && prev.sound_path !== newSoundPath) {
			await removeCardArt(prev.sound_path as string);
		}
		// "Remove all models" → delete every old model file (array + legacy single).
		if (modelsCleared) {
			for (const m of prevModels) await removeCardArt(m?.path ?? null);
			await removeCardArt((prev?.model_path as string | null) ?? null);
		}
		// Any prior layer file no longer in the final set (removed/replaced) is orphaned.
		if (finalLayerPaths) {
			for (const p of prevLayerPaths) {
				if (!finalLayerPaths.includes(p)) await removeCardArt(p);
			}
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
			.select('front_path, back_path, holo_path, sound_path, model_path, models, layers')
			.eq('id', id)
			.maybeSingle();

		const { error: delErr } = await db().from('vs_cards').delete().eq('id', id);
		if (delErr) return fail(500, { error: delErr.message });

		await removeCardArt(existing?.front_path as string | null);
		await removeCardArt(existing?.back_path as string | null);
		await removeCardArt(existing?.holo_path as string | null);
		await removeCardArt(existing?.sound_path as string | null);
		await removeCardArt(existing?.model_path as string | null);
		if (Array.isArray(existing?.models)) {
			for (const m of existing.models as { path?: string }[]) await removeCardArt(m?.path);
		}
		if (Array.isArray(existing?.layers)) {
			for (const l of existing.layers as { path?: string }[]) await removeCardArt(l?.path);
		}

		return { ok: true };
	},

	// Save the 3D models from the visual builder (CardModelBuilder.svelte): the full set
	// with per-model placement. Deletes the storage files of any models removed in the builder.
	updateModels: async ({ locals, request }) => {
		if (!locals.user || !isCardTester(locals.user)) throw error(403, 'Not allowed');

		const form = await request.formData();
		const id = form.get('card_id')?.toString();
		if (!id) return fail(400, { error: 'Missing id' });

		let raw: unknown;
		try {
			raw = JSON.parse(form.get('models')?.toString() ?? '[]');
		} catch {
			return fail(400, { error: 'Invalid models' });
		}
		const models = sanitizeModels(raw);

		const { data: prev } = await db().from('vs_cards').select('models').eq('id', id).maybeSingle();

		const { error: updErr } = await db()
			.from('vs_cards')
			.update({ models, updated_at: new Date().toISOString() })
			.eq('id', id);
		if (updErr) return fail(500, { error: updErr.message });

		// Delete storage files for models removed in the builder.
		const keep = new Set(models.map((m) => m.path).filter(Boolean));
		if (Array.isArray(prev?.models)) {
			for (const m of prev.models as { path?: string }[]) {
				if (m?.path && !keep.has(m.path)) await removeCardArt(m.path);
			}
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
			discount_pct: form.get('discount_pct') ?? '0',
			discount_vp_pct: form.get('discount_vp_pct') ?? '0',
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
				cost_gp: parsePackGp(form),
				discount_pct: parsed.data.discount_pct,
				discount_vp_pct: parsed.data.discount_vp_pct,
				cards_per_pack: parsed.data.cards_per_pack,
				released: form.get('released') === 'on',
				teaser: form.get('teaser') === 'on'
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
			discount_pct: form.get('discount_pct') ?? '0',
			discount_vp_pct: form.get('discount_vp_pct') ?? '0',
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
		const slotFinishes: { holo: number; reverse: number }[] = [];
		const pctClamp = (v: number) => (Number.isFinite(v) ? Math.min(100, Math.max(0, v)) : 0);
		for (let i = 0; i < parsed.data.cards_per_pack; i++) {
			const slot: Record<string, number> = {};
			for (const r of RARITIES) {
				const v = Number(form.get(`slot_${i}_weight_${r.key}`) ?? 0);
				if (Number.isFinite(v) && v > 0) slot[r.key] = v;
			}
			slotWeights.push(slot);
			// Per-slot holo / reverse-holo chances (percent; remainder is Normal).
			slotFinishes.push({
				holo: pctClamp(Number(form.get(`slot_${i}_holo`) ?? 0)),
				reverse: pctClamp(Number(form.get(`slot_${i}_reverse`) ?? 0))
			});
		}

		const update: Record<string, unknown> = {
			name: parsed.data.name,
			description: parsed.data.description,
			cost_vp: parsed.data.cost_vp,
			cost_gp: parsePackGp(form),
			discount_pct: parsed.data.discount_pct,
			discount_vp_pct: parsed.data.discount_vp_pct,
			cards_per_pack: parsed.data.cards_per_pack,
			slot_weights: slotWeights,
			slot_finishes: slotFinishes,
			updated_at: new Date().toISOString()
		};

		const { data: prev } = await db()
			.from('vs_card_packs')
			.select('front_path, back_path, holo_regular_path, holo_reverse_path')
			.eq('id', id)
			.maybeSingle();

		const faces = await uploadCardFaces('packs', id, form);
		if ('error' in faces) return fail(400, { error: faces.error });
		Object.assign(update, faces.update);

		// Per-pack holo foils: a "remove" toggle clears each; uploading replaces it.
		if (form.get('remove_holo_regular') === 'on' && !faces.update.holo_regular_path) {
			update.holo_regular_path = null;
			update.holo_regular_url = null;
		}
		if (form.get('remove_holo_reverse') === 'on' && !faces.update.holo_reverse_path) {
			update.holo_reverse_path = null;
			update.holo_reverse_url = null;
		}

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
		// Per-pack holo foils replaced or cleared → delete the old files.
		for (const face of ['holo_regular', 'holo_reverse'] as const) {
			const oldPath = prev?.[`${face}_path`] as string | null | undefined;
			const cleared = form.get(`remove_${face}`) === 'on';
			const newPath = faces.update[`${face}_path`];
			if (oldPath && (newPath || cleared) && oldPath !== newPath) {
				await removeCardArt(oldPath);
			}
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

	// Flag (or unflag) a pack as the free WEEKLY pack. Single-winner: setting one
	// clears the flag on every other pack so exactly one weekly freebie is active.
	toggleWeeklyFree: async ({ locals, request }) => {
		if (!locals.user || !isCardTester(locals.user)) throw error(403, 'Not allowed');

		const form = await request.formData();
		const id = form.get('id')?.toString();
		if (!id) return fail(400, { error: 'Missing id' });

		const { data: prev, error: readErr } = await db()
			.from('vs_card_packs')
			.select('weekly_free')
			.eq('id', id)
			.maybeSingle();
		if (readErr) return fail(500, { error: readErr.message });
		if (!prev) return fail(404, { error: 'Pack not found' });

		const next = !prev.weekly_free;
		if (next) {
			// Clear any existing weekly pack first (only one at a time).
			const { error: clearErr } = await db()
				.from('vs_card_packs')
				.update({ weekly_free: false, updated_at: new Date().toISOString() })
				.eq('weekly_free', true);
			if (clearErr) return fail(500, { error: clearErr.message });
		}

		const { error: updErr } = await db()
			.from('vs_card_packs')
			.update({ weekly_free: next, updated_at: new Date().toISOString() })
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
			.select('front_path, back_path, holo_regular_path, holo_reverse_path')
			.eq('id', id)
			.maybeSingle();

		const { error: delErr } = await db().from('vs_card_packs').delete().eq('id', id);
		if (delErr) return fail(500, { error: delErr.message });

		await removeCardArt(existing?.front_path as string | null);
		await removeCardArt(existing?.back_path as string | null);
		await removeCardArt(existing?.holo_regular_path as string | null);
		await removeCardArt(existing?.holo_reverse_path as string | null);

		return { ok: true };
	},

	/* ------------------------------- Grant ------------------------------- */

	// Manually award packs to a member or to everyone. Packs go to vs_user_packs,
	// whose user_id FKs vs_users — so only members who've SIGNED INTO THE SITE can
	// receive (the bot's `players` roster alone isn't enough).
	grantPacks: async ({ locals, request }) => {
		// "Other feature" — admins may grant packs too (editing the catalog still can't).
		if (!locals.user || !isCardAdmin(locals.user)) throw error(403, 'Not allowed');

		const form = await request.formData();
		const packId = form.get('pack_id')?.toString();
		const target = form.get('target')?.toString(); // 'one' | 'all'
		const userId = form.get('user_id')?.toString();
		const qty = Math.floor(Number(form.get('quantity') ?? 1));

		if (!packId) return fail(400, { error: 'Pick a pack.' });
		if (!Number.isFinite(qty) || qty < 1 || qty > MAX_QTY) {
			return fail(400, { error: `Quantity must be between 1 and ${MAX_QTY}.` });
		}

		// Pack must exist (released or not — admins can grant unreleased sets).
		const { data: pack, error: pErr } = await db()
			.from('vs_card_packs')
			.select('id, name')
			.eq('id', packId)
			.maybeSingle();
		if (pErr) return fail(500, { error: pErr.message });
		if (!pack) return fail(404, { error: 'That pack no longer exists.' });

		const plural = qty === 1 ? 'pack' : 'packs';

		// ── Award to ONE member ──────────────────────────────────────────────
		if (target !== 'all') {
			if (!userId) return fail(400, { error: 'Pick a member (or choose Everyone).' });
			const { data: member, error: mErr } = await db()
				.from('vs_users')
				.select('id, rsn, discord_username')
				.eq('id', userId)
				.maybeSingle();
			if (mErr) return fail(500, { error: mErr.message });
			if (!member) return fail(404, { error: 'That member no longer exists.' });

			const ok = await grantUserPack(userId, packId, qty);
			if (!ok) return fail(500, { error: 'Could not award the pack — please try again.' });

			const who = member.rsn || member.discord_username || 'that member';
			return { ok: true, message: `Awarded ${qty} ${pack.name} ${plural} to ${who}.` };
		}

		// ── Award to EVERYONE (all site members) ─────────────────────────────
		// Paginate: both vs_users and (per-pack) vs_user_packs can exceed the 1000-row cap.
		const { data: users, error: uErr } = await fetchAllFiltered((f, t) =>
			db().from('vs_users').select('id').range(f, t)
		);
		if (uErr) return fail(500, { error: uErr.message });
		const ids = (users ?? []).map((u) => (u as { id: string }).id);
		if (ids.length === 0) return fail(400, { error: 'There are no site members to award to.' });

		// Read existing quantities for this pack so the upsert (which SETS quantity)
		// adds to what each member already has instead of overwriting it.
		const { data: existing, error: eErr } = await fetchAllFiltered((f, t) =>
			db().from('vs_user_packs').select('user_id, quantity').eq('pack_id', packId).range(f, t)
		);
		if (eErr) return fail(500, { error: eErr.message });
		const have = new Map<string, number>();
		for (const r of (existing ?? []) as { user_id: string; quantity: number }[])
			have.set(r.user_id, r.quantity ?? 0);

		const now = new Date().toISOString();
		const rows = ids.map((id) => ({
			user_id: id,
			pack_id: packId,
			quantity: (have.get(id) ?? 0) + qty,
			updated_at: now
		}));
		const { error: upErr } = await db()
			.from('vs_user_packs')
			.upsert(rows, { onConflict: 'user_id,pack_id' });
		if (upErr) return fail(500, { error: upErr.message });

		return { ok: true, message: `Awarded ${qty} ${pack.name} ${plural} to all ${ids.length} members.` };
	}
};
