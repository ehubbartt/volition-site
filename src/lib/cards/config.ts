export const CARD_ART_BUCKET = 'vs-card-art';

export const MAX_UPLOAD_BYTES = 10_000_000;
export const ALLOWED_MIME = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const;

// Max stacked depth layers a single card may have (above its front face).
export const MAX_CARD_LAYERS = 6;

// Depth layers may be still images OR a short animation (WEBM/MP4) — videos render
// as a looping VideoTexture in the 3D views. Allow a larger cap since video is heavier.
export const MAX_LAYER_BYTES = 25_000_000;
export const ALLOWED_LAYER_MIME = [
	'image/png',
	'image/jpeg',
	'image/webp',
	'image/gif',
	'video/webm',
	'video/mp4'
] as const;
export const EXT_BY_LAYER_MIME: Record<string, string> = {
	'image/png': 'png',
	'image/jpeg': 'jpg',
	'image/webp': 'webp',
	'image/gif': 'gif',
	'video/webm': 'webm',
	'video/mp4': 'mp4'
};
// File-extension list for the admin form's <input accept> (mirrors the MIME list).
export const LAYER_ACCEPT = 'image/png,image/jpeg,image/webp,image/gif,video/webm,video/mp4';

// True if a layer URL points at a video file (→ load as VideoTexture, not an image).
// Client-safe (pure regex, no three import) so the admin UI can use it too.
export function isVideoLayerUrl(url: string): boolean {
	return /\.(webm|mp4|m4v|mov|ogv)(\?|#|$)/i.test(url);
}

// Null-safe generic alias — a card's FRONT face may also be a video (see below).
export function isVideoUrl(url: string | null | undefined): boolean {
	return !!url && isVideoLayerUrl(url);
}

// A card's FRONT face may be a still image OR a short looping video (WEBM/MP4) — the
// video plays as a VideoTexture in the 3D views and a <video> in 2D tiles. Cards only
// (pack fronts stay image). Bigger cap than a still since video is heavier.
export const MAX_FRONT_BYTES = 25_000_000;
export const ALLOWED_FRONT_MIME = [
	'image/png',
	'image/jpeg',
	'image/webp',
	'image/gif',
	'video/webm',
	'video/mp4'
] as const;
export const EXT_BY_FRONT_MIME: Record<string, string> = {
	'image/png': 'png',
	'image/jpeg': 'jpg',
	'image/webp': 'webp',
	'image/gif': 'gif',
	'video/webm': 'webm',
	'video/mp4': 'mp4'
};
// <input accept> for the card front (images + video).
export const FRONT_ACCEPT = 'image/png,image/jpeg,image/webp,image/gif,video/webm,video/mp4';

// Per-card open sound (plays when the card is revealed in the pack opener).
export const MAX_AUDIO_BYTES = 5_000_000;
export const ALLOWED_AUDIO_MIME = [
	'audio/mpeg',
	'audio/wav',
	'audio/x-wav',
	'audio/ogg',
	'audio/webm',
	'audio/mp4',
	'audio/x-m4a',
	'audio/aac'
] as const;
export const EXT_BY_AUDIO_MIME: Record<string, string> = {
	'audio/mpeg': 'mp3',
	'audio/wav': 'wav',
	'audio/x-wav': 'wav',
	'audio/ogg': 'ogg',
	'audio/webm': 'weba',
	'audio/mp4': 'm4a',
	'audio/x-m4a': 'm4a',
	'audio/aac': 'aac'
};

export const EXT_BY_MIME: Record<string, string> = {
	'image/png': 'png',
	'image/jpeg': 'jpg',
	'image/webp': 'webp',
	'image/gif': 'gif'
};
