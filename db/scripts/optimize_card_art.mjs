// One-time backfill: shrink EXISTING card/pack art in the `vs-card-art` bucket to
// WebP (max 1024px, never upscaled) and re-point the DB rows at the smaller files.
// Mirrors what cardArt.ts now does on upload, but for art uploaded before that.
//
// Idempotent + re-runnable: anything already `.webp` (or a video) is skipped, and the
// old originals are LEFT in place (so this is reversible) — clean them up later if you
// like. Best-effort per object: a failure on one face doesn't stop the run.
//
// Run (Node 20+, from the repo root):
//   node --env-file=.env db/scripts/optimize_card_art.mjs
// Needs SUPABASE_URL + SUPABASE_ANON_KEY (RLS is off, anon key has write — same as the app).

import { createClient } from '@supabase/supabase-js';
import sharp from 'sharp';

const BUCKET = 'vs-card-art';
const MAX_DIM = 1024;
const QUALITY = 82;
const CACHE_CONTROL = '31536000'; // 1 year
const VIDEO_RE = /\.(webm|mp4|m4v|mov|ogv)$/i;

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
	console.error('Missing SUPABASE_URL / SUPABASE_ANON_KEY. Try: node --env-file=.env db/scripts/optimize_card_art.mjs');
	process.exit(1);
}
const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

let optimized = 0;
let skipped = 0;
let failed = 0;

// Optimize one storage object (by its bucket path). Returns the new { path, url } or
// null when skipped/failed (caller keeps the existing value).
async function processArt(path) {
	if (!path) return null;
	if (/\.webp$/i.test(path) || VIDEO_RE.test(path)) {
		skipped++;
		return null;
	}
	const { data: blob, error: dErr } = await sb.storage.from(BUCKET).download(path);
	if (dErr || !blob) {
		console.warn('  download failed:', path, dErr?.message ?? '');
		failed++;
		return null;
	}
	let out;
	try {
		const input = Buffer.from(await blob.arrayBuffer());
		out = await sharp(input, { animated: /\.gif$/i.test(path) })
			.rotate()
			.resize(MAX_DIM, MAX_DIM, { fit: 'inside', withoutEnlargement: true })
			.webp({ quality: QUALITY })
			.toBuffer();
	} catch (e) {
		console.warn('  optimize failed:', path, e instanceof Error ? e.message : e);
		failed++;
		return null;
	}
	const newPath = `${path.replace(/\.[a-z0-9]+$/i, '')}-opt-${Date.now()}.webp`;
	const { error: uErr } = await sb.storage.from(BUCKET).upload(newPath, out, {
		contentType: 'image/webp',
		cacheControl: CACHE_CONTROL,
		upsert: false
	});
	if (uErr) {
		console.warn('  upload failed:', newPath, uErr.message);
		failed++;
		return null;
	}
	const { data: pub } = sb.storage.from(BUCKET).getPublicUrl(newPath);
	optimized++;
	return { path: newPath, url: pub.publicUrl };
}

async function processFaces(table, row, faces) {
	const update = {};
	for (const face of faces) {
		const res = await processArt(row[`${face}_path`]);
		if (res) {
			update[`${face}_path`] = res.path;
			update[`${face}_url`] = res.url;
		}
	}
	return update;
}

async function run() {
	// --- Packs ---
	const { data: packs, error: pErr } = await sb
		.from('vs_card_packs')
		.select('id, name, front_path, back_path, holo_regular_path, holo_reverse_path');
	if (pErr) throw new Error(`packs fetch: ${pErr.message}`);
	for (const p of packs ?? []) {
		const update = await processFaces('vs_card_packs', p, ['front', 'back', 'holo_regular', 'holo_reverse']);
		if (Object.keys(update).length) {
			update.updated_at = new Date().toISOString();
			const { error } = await sb.from('vs_card_packs').update(update).eq('id', p.id);
			if (error) console.warn('pack update failed:', p.name, error.message);
			else console.log('pack ✓', p.name);
		}
	}

	// --- Cards (faces + depth layers) ---
	const { data: cards, error: cErr } = await sb
		.from('vs_cards')
		.select('id, name, front_path, back_path, holo_path, layers');
	if (cErr) throw new Error(`cards fetch: ${cErr.message}`);
	for (const c of cards ?? []) {
		const update = await processFaces('vs_cards', c, ['front', 'back', 'holo']);

		const layers = Array.isArray(c.layers) ? c.layers : [];
		if (layers.length) {
			let changed = false;
			const next = [];
			for (const ly of layers) {
				const res = await processArt(ly?.path);
				if (res) {
					next.push({ ...ly, path: res.path, url: res.url });
					changed = true;
				} else {
					next.push(ly);
				}
			}
			if (changed) update.layers = next;
		}

		if (Object.keys(update).length) {
			update.updated_at = new Date().toISOString();
			const { error } = await sb.from('vs_cards').update(update).eq('id', c.id);
			if (error) console.warn('card update failed:', c.name, error.message);
			else console.log('card ✓', c.name);
		}
	}

	console.log(`\nDone. optimized=${optimized} skipped=${skipped} failed=${failed}`);
}

run().catch((e) => {
	console.error(e);
	process.exit(1);
});
