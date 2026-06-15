export const CARD_ART_BUCKET = 'vs-card-art';

export const MAX_UPLOAD_BYTES = 10_000_000;
export const ALLOWED_MIME = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const;

// Max stacked depth layers a single card may have (above its front face).
export const MAX_CARD_LAYERS = 6;

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
