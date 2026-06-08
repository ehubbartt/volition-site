import { db } from './db';
import {
	CARD_ART_BUCKET,
	MAX_UPLOAD_BYTES,
	ALLOWED_MIME,
	EXT_BY_MIME,
	MAX_CARD_LAYERS
} from '$lib/cards/config';

// Shared art upload for the card game. Cards and packs both live in the
// `vs-card-art` bucket under their own prefix ('cards' / 'packs').
export async function uploadCardArt(
	prefix: 'cards' | 'packs',
	id: string,
	file: File
): Promise<{ path: string; url: string } | { error: string }> {
	if (file.size > MAX_UPLOAD_BYTES) {
		const mb = Math.round(MAX_UPLOAD_BYTES / 1_000_000);
		return { error: `Art too large (max ${mb} MB)` };
	}
	if (!(ALLOWED_MIME as readonly string[]).includes(file.type)) {
		return { error: 'Unsupported image type (use PNG, JPEG, WEBP, or GIF)' };
	}
	const ext = EXT_BY_MIME[file.type];
	if (!ext) return { error: 'Unsupported image type' };

	const path = `${prefix}/${id}-${Date.now()}.${ext}`;
	const storage = db().storage.from(CARD_ART_BUCKET);
	const { error: upErr } = await storage.upload(path, file, {
		contentType: file.type,
		upsert: false
	});
	if (upErr) return { error: upErr.message };

	const { data: pub } = storage.getPublicUrl(path);
	return { path, url: pub.publicUrl };
}

export async function removeCardArt(path: string | null | undefined): Promise<void> {
	if (path) await db().storage.from(CARD_ART_BUCKET).remove([path]);
}

// Uploads an ordered set of 3D depth-layer images for a card and returns their
// {path, url} entries (bottom→top, in the order given). On any error, anything
// uploaded in this call is rolled back. Empty file slots are skipped.
export async function uploadCardLayers(
	id: string,
	files: File[]
): Promise<{ layers: { path: string; url: string }[]; uploadedPaths: string[] } | { error: string }> {
	const real = files.filter((f) => f instanceof File && f.size > 0);
	if (real.length > MAX_CARD_LAYERS) {
		return { error: `Too many layers (max ${MAX_CARD_LAYERS})` };
	}

	const layers: { path: string; url: string }[] = [];
	const uploadedPaths: string[] = [];

	for (let i = 0; i < real.length; i++) {
		const result = await uploadCardArt('cards', `${id}-layer${i}`, real[i]);
		if ('error' in result) {
			for (const p of uploadedPaths) await removeCardArt(p);
			return { error: result.error };
		}
		layers.push(result);
		uploadedPaths.push(result.path);
	}

	return { layers, uploadedPaths };
}

// Uploads the optional `front` / `back` files from a form for a card or pack and
// returns the matching column update ({front_path, front_url, back_path, back_url}
// for whichever were provided), plus the new storage paths for cleanup on failure.
// On any upload error, anything already uploaded in this call is rolled back.
export async function uploadCardFaces(
	prefix: 'cards' | 'packs',
	id: string,
	form: FormData
): Promise<{ update: Record<string, string>; uploadedPaths: string[] } | { error: string }> {
	const update: Record<string, string> = {};
	const uploadedPaths: string[] = [];

	for (const face of ['front', 'back'] as const) {
		const file = form.get(face);
		if (!(file instanceof File) || file.size === 0) continue;

		const result = await uploadCardArt(prefix, `${id}-${face}`, file);
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
