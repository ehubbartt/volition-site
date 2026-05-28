export const BINGO_EVENT_SLUG = 'echo-rumors';

export const BINGO_ROW_COUNT = 12;
export const BINGO_ROW_INTERVAL_HOURS = 14;

export const BINGO_BUCKET = 'vs-bingo-proofs';

export const MAX_UPLOAD_BYTES = 10_000_000;
export const MAX_IMAGES_PER_SUBMISSION = 6;
export const ALLOWED_MIME = [
	'image/png',
	'image/jpeg',
	'image/webp',
	'image/gif'
] as const;
