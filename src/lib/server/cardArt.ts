import { db } from './db';
import {
	CARD_ART_BUCKET,
	ART_CACHE_CONTROL,
	MAX_ART_DIMENSION,
	ART_WEBP_QUALITY,
	MAX_UPLOAD_BYTES,
	ALLOWED_MIME,
	EXT_BY_MIME,
	MAX_CARD_LAYERS,
	MAX_LAYER_BYTES,
	ALLOWED_LAYER_MIME,
	EXT_BY_LAYER_MIME,
	MAX_AUDIO_BYTES,
	ALLOWED_AUDIO_MIME,
	EXT_BY_AUDIO_MIME,
	MAX_FRONT_BYTES,
	ALLOWED_FRONT_MIME,
	EXT_BY_FRONT_MIME
} from '$lib/cards/config';
import { isLayerEffect, type LayerEffect } from '$lib/cards/layerEffects';

// Downscale a still image to MAX_ART_DIMENSION (longest side, never upscale) and
// re-encode as WebP — the 3D card/pack planes never need more than ~1024px and the
// source PNGs are often multi-MB. Returns null on any failure so the caller falls
// back to uploading the original untouched (never blocks an admin upload). Videos
// must NOT be passed here. Animated GIFs become animated WebP.
async function optimizeImage(
	file: File
): Promise<{ data: Buffer; contentType: string; ext: string } | null> {
	try {
		const { default: sharp } = await import('sharp');
		const input = Buffer.from(await file.arrayBuffer());
		const data = await sharp(input, { animated: file.type === 'image/gif' })
			.rotate() // honour EXIF orientation before we drop the metadata
			.resize(MAX_ART_DIMENSION, MAX_ART_DIMENSION, { fit: 'inside', withoutEnlargement: true })
			.webp({ quality: ART_WEBP_QUALITY })
			.toBuffer();
		return { data, contentType: 'image/webp', ext: 'webp' };
	} catch (e) {
		console.error('[cardArt] image optimize failed, uploading original:', e instanceof Error ? e.message : e);
		return null;
	}
}

// Shared art upload for the card game. Cards and packs both live in the
// `vs-card-art` bucket under their own prefix ('cards' / 'packs'). `opts` lets callers
// widen the accepted types (e.g. depth layers also allow WEBM/MP4 video).
export async function uploadCardArt(
	prefix: 'cards' | 'packs',
	id: string,
	file: File,
	opts: {
		allowedMime?: readonly string[];
		maxBytes?: number;
		extMap?: Record<string, string>;
		typeError?: string;
	} = {}
): Promise<{ path: string; url: string } | { error: string }> {
	const allowedMime = opts.allowedMime ?? ALLOWED_MIME;
	const maxBytes = opts.maxBytes ?? MAX_UPLOAD_BYTES;
	const extMap = opts.extMap ?? EXT_BY_MIME;
	const typeError = opts.typeError ?? 'Unsupported image type (use PNG, JPEG, WEBP, or GIF)';

	if (file.size > maxBytes) {
		const mb = Math.round(maxBytes / 1_000_000);
		return { error: `File too large (max ${mb} MB)` };
	}
	if (!(allowedMime as readonly string[]).includes(file.type)) {
		return { error: typeError };
	}
	let ext = extMap[file.type];
	if (!ext) return { error: typeError };

	// Still images → downscale + WebP. Videos (and anything non-image) upload as-is.
	let body: File | Buffer = file;
	let contentType = file.type;
	if (file.type.startsWith('image/')) {
		const optimized = await optimizeImage(file);
		if (optimized) {
			body = optimized.data;
			contentType = optimized.contentType;
			ext = optimized.ext;
		}
	}

	const path = `${prefix}/${id}-${Date.now()}.${ext}`;
	const storage = db().storage.from(CARD_ART_BUCKET);
	const { error: upErr } = await storage.upload(path, body, {
		contentType,
		upsert: false,
		cacheControl: ART_CACHE_CONTROL
	});
	if (upErr) return { error: upErr.message };

	const { data: pub } = storage.getPublicUrl(path);
	return { path, url: pub.publicUrl };
}

export async function removeCardArt(path: string | null | undefined): Promise<void> {
	if (path) await db().storage.from(CARD_ART_BUCKET).remove([path]);
}

// Uploads a card's open sound (audio) to the same bucket. Returns {path, url}.
export async function uploadCardSound(
	id: string,
	file: File
): Promise<{ path: string; url: string } | { error: string }> {
	if (file.size > MAX_AUDIO_BYTES) {
		const mb = Math.round(MAX_AUDIO_BYTES / 1_000_000);
		return { error: `Sound too large (max ${mb} MB)` };
	}
	if (!(ALLOWED_AUDIO_MIME as readonly string[]).includes(file.type)) {
		return { error: 'Unsupported audio type (use MP3, WAV, OGG, or M4A)' };
	}
	const ext = EXT_BY_AUDIO_MIME[file.type];
	if (!ext) return { error: 'Unsupported audio type' };

	const path = `cards/${id}-sound-${Date.now()}.${ext}`;
	const storage = db().storage.from(CARD_ART_BUCKET);
	const { error: upErr } = await storage.upload(path, file, {
		contentType: file.type,
		upsert: false,
		cacheControl: ART_CACHE_CONTROL
	});
	if (upErr) return { error: upErr.message };

	const { data: pub } = storage.getPublicUrl(path);
	return { path, url: pub.publicUrl };
}

// Uploads an ordered set of 3D depth-layer images for a card and returns their
// {path, url, effect} entries (bottom→top, in the order given). `effects` is an
// optional parallel array of animation-effect keys (see layerEffects.ts); invalid
// entries fall back to no effect. On any error, anything uploaded in this call is
// rolled back. Empty file slots are skipped.
export async function uploadCardLayers(
	id: string,
	files: File[],
	effects: (string | null | undefined)[] = []
): Promise<{
	layers: { path: string; url: string; effect: LayerEffect | null }[];
	uploadedPaths: string[];
} | { error: string }> {
	const real = files.filter((f) => f instanceof File && f.size > 0);
	if (real.length > MAX_CARD_LAYERS) {
		return { error: `Too many layers (max ${MAX_CARD_LAYERS})` };
	}

	const layers: { path: string; url: string; effect: LayerEffect | null }[] = [];
	const uploadedPaths: string[] = [];

	for (let i = 0; i < real.length; i++) {
		const result = await uploadCardArt('cards', `${id}-layer${i}`, real[i], {
			allowedMime: ALLOWED_LAYER_MIME,
			maxBytes: MAX_LAYER_BYTES,
			extMap: EXT_BY_LAYER_MIME,
			typeError: 'Unsupported layer type (use PNG, JPEG, WEBP, GIF, WEBM, or MP4)'
		});
		if ('error' in result) {
			for (const p of uploadedPaths) await removeCardArt(p);
			return { error: result.error };
		}
		const effect = effects[i];
		layers.push({ ...result, effect: isLayerEffect(effect) ? effect : null });
		uploadedPaths.push(result.path);
	}

	return { layers, uploadedPaths };
}

// Uploads the optional `front` / `back` / `holo` files from a form for a card or
// pack and returns the matching column update ({front_path, front_url, …} for
// whichever were provided), plus the new storage paths for cleanup on failure. The
// `holo` face is card-only (the full-art holo texture); packs never send it. On any
// upload error, anything already uploaded in this call is rolled back.
export async function uploadCardFaces(
	prefix: 'cards' | 'packs',
	id: string,
	form: FormData
): Promise<{ update: Record<string, string>; uploadedPaths: string[] } | { error: string }> {
	const update: Record<string, string> = {};
	const uploadedPaths: string[] = [];

	for (const face of ['front', 'back', 'holo', 'holo_regular', 'holo_reverse'] as const) {
		const file = form.get(face);
		if (!(file instanceof File) || file.size === 0) continue;

		// A CARD's front face may also be a short video (WEBM/MP4); every other face
		// (and all pack faces) stays image-only.
		const frontVideoOk = prefix === 'cards' && face === 'front';
		const result = await uploadCardArt(prefix, `${id}-${face}`, file, frontVideoOk
			? {
					allowedMime: ALLOWED_FRONT_MIME,
					maxBytes: MAX_FRONT_BYTES,
					extMap: EXT_BY_FRONT_MIME,
					typeError: 'Unsupported front type (use PNG, JPEG, WEBP, GIF, WEBM, or MP4)'
				}
			: {});
		if ('error' in result) {
			for (const p of uploadedPaths) await removeCardArt(p);
			return { error: result.error };
		}
		update[`${face}_path`] = result.path;
		update[`${face}_url`] = result.url;
		uploadedPaths.push(result.path);
	}

	return { update, uploadedPaths };
}
