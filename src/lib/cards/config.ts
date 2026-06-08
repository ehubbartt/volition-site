export const CARD_ART_BUCKET = 'vs-card-art';

export const MAX_UPLOAD_BYTES = 10_000_000;
export const ALLOWED_MIME = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const;

// Max stacked depth layers a single card may have (above its front face).
export const MAX_CARD_LAYERS = 6;

export const EXT_BY_MIME: Record<string, string> = {
	'image/png': 'png',
	'image/jpeg': 'jpg',
	'image/webp': 'webp',
	'image/gif': 'gif'
};
