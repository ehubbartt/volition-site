import { redirect, error, fail } from '@sveltejs/kit';
import { z } from 'zod';
import { db } from '$lib/server/db';
import { isCardTester } from '$lib/server/auth';
import { uploadCardFaces, uploadCardLayers, uploadCardSound, removeCardArt } from '$lib/server/cardArt';
import { grantUserPack } from '$lib/server/gamba';
import { isValidRarity, RARITIES, DEFAULT_RARITY, type CardAbility } from '$lib/cards/rarity';
import { isLayerEffect } from '$lib/cards/layerEffects';
import type { Actions, PageServerLoad } from './$types';

// Cap on a single manual pack grant (the "Grant" tab).
const MAX_QTY = 100;

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) throw redirect(303, '/');
	if (!isCardTester(locals.user)) throw error(403, 'Not allowed');

	const [cardsRes, packsRes, membersRes] = await Promise.all([
		db()
			.from('vs_cards')
			.select(
				'id, name, level, rarity, pack_id, abilities, flavor, front_path, front_url, back_path, back_url, holo_path, holo_url, sound_path, sound_url, layers, full_art, created_at'
			)
			.order('created_at', { ascending: false }),
		db()
			.from('vs_card_packs')
			.select(
				'id, name, description, cost_vp, cards_per_pack, released, rarity_weights, slot_weights, slot_finishes, front_path, front_url, back_path, back_url, holo_regular_path, holo_regular_url, holo_reverse_path, holo_reverse_url, created_at'
			)
			.order('created_at', { ascending: false }),
		// Grant tab: every member with a site profile (the only grantable targets —
		// vs_user_packs.user_id FKs vs_users, so bot-roster-only members can't receive).
		db().from('vs_users').select('id, rsn, discord_username').order('rsn', { ascending: true })
	]);

	if (cardsRes.error) throw error(500, cardsRes.error.message);
	if (packsRes.error) throw error(500, packsRes.error.message);
	if (membersRes.error) throw error(500, membersRes.error.message);

	return { cards: cardsRes.data ?? [], packs: packsRes.data ?? [], members: membersRes.data ?? [] };
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
				abilities,
				full_art: form.get('full_art') === 'on'
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
			updated_at: new Date().toISOString()
		};

		// Snapshot old paths so we can delete any face/layer that gets replaced.
		const { data: prev } = await db()
			.from('vs_cards')
			.select('front_path, back_path, holo_path, sound_path, layers')
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

		// Remove the full-art holo image (clears it; a new upload replaces instead).
		const removeHolo = form.get('remove_holo') === 'on';
		if (removeHolo && !faces.update.holo_path) {
			update.holo_path = null;
			update.holo_url = null;
		}

		// 3D depth layers: the "clear" toggle empties them; uploading any layer files
		// REPLACES the whole set (bottom→top in upload order); otherwise the per-layer
		// effect dropdowns update each existing layer's animation effect IN PLACE
		// (keeping its image, so no re-upload is needed just to change an effect).
		const clearLayers = form.get('clear_layers') === 'on';
		const layerFiles = form.getAll('layer').filter((f): f is File => f instanceof File && f.size > 0);
		let replacedLayers = false;
		if (clearLayers) {
			update.layers = [];
			replacedLayers = true;
		} else if (layerFiles.length) {
			const layerEffects = form.getAll('layer_effect').map((v) => v.toString());
			const up = await uploadCardLayers(id, layerFiles, layerEffects);
			if ('error' in up) {
				for (const p of faces.uploadedPaths) await removeCardArt(p);
				return fail(400, { error: up.error });
			}
			update.layers = up.layers;
			replacedLayers = true;
		} else {
			// No new files / not clearing — apply per-existing-layer effect edits.
			const effects = form.getAll('existing_layer_effect').map((v) => v.toString());
			if (effects.length && Array.isArray(prev?.layers) && prev.layers.length) {
				update.layers = (prev.layers as { path?: string; url?: string }[]).map((l, i) => ({
					path: l.path,
					url: l.url,
					effect: isLayerEffect(effects[i]) ? effects[i] : null
				}));
			}
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
			.select('front_path, back_path, holo_path, sound_path, layers')
			.eq('id', id)
			.maybeSingle();

		const { error: delErr } = await db().from('vs_cards').delete().eq('id', id);
		if (delErr) return fail(500, { error: delErr.message });

		await removeCardArt(existing?.front_path as string | null);
		await removeCardArt(existing?.back_path as string | null);
		await removeCardArt(existing?.holo_path as string | null);
		await removeCardArt(existing?.sound_path as string | null);
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
		if (!locals.user || !isCardTester(locals.user)) throw error(403, 'Not allowed');

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
		const { data: users, error: uErr } = await db().from('vs_users').select('id');
		if (uErr) return fail(500, { error: uErr.message });
		const ids = (users ?? []).map((u) => u.id);
		if (ids.length === 0) return fail(400, { error: 'There are no site members to award to.' });

		// Read existing quantities for this pack so the upsert (which SETS quantity)
		// adds to what each member already has instead of overwriting it.
		const { data: existing, error: eErr } = await db()
			.from('vs_user_packs')
			.select('user_id, quantity')
			.eq('pack_id', packId);
		if (eErr) return fail(500, { error: eErr.message });
		const have = new Map<string, number>();
		for (const r of existing ?? []) have.set(r.user_id as string, (r.quantity as number) ?? 0);

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
