import type { BingoTier } from '$lib/bingo/tiles';
import { TIERS } from '$lib/bingo/tiles';

export const BINGO_EVENT_SLUG = 'echo-rumors';

export const BINGO_ROW_COUNT = 12;
export const BINGO_ROW_INTERVAL_HOURS = 14;

// Per-event structural config. Builder-created events carry their own copy in
// vs_events.structure; the legacy echo-rumors event (and anything with no
// structure stored) falls back to DEFAULT_BINGO_STRUCTURE below.
export interface BingoTierConfig {
	key: BingoTier;
	label: string;
	points: number;
}

export interface BingoStructure {
	rowCount: number;
	rowIntervalHours: number;
	bonusEnabled: boolean;
	tiers: BingoTierConfig[];
}

export const DEFAULT_BINGO_STRUCTURE: BingoStructure = {
	rowCount: BINGO_ROW_COUNT,
	rowIntervalHours: BINGO_ROW_INTERVAL_HOURS,
	bonusEnabled: true,
	tiers: TIERS.map((t) => ({ key: t.key, label: t.label, points: t.points }))
};

// Narrow an unknown jsonb value (vs_events.structure / template structure) into a
// BingoStructure, filling any missing field from the default so callers are safe.
export function normalizeBingoStructure(raw: unknown): BingoStructure {
	if (!raw || typeof raw !== 'object') return DEFAULT_BINGO_STRUCTURE;
	const r = raw as Record<string, unknown>;
	const rowCount = Number(r.rowCount);
	const rowIntervalHours = Number(r.rowIntervalHours);
	const tiers = Array.isArray(r.tiers)
		? (r.tiers as unknown[])
				.map((t) => {
					const o = (t ?? {}) as Record<string, unknown>;
					return {
						key: String(o.key) as BingoTier,
						label: String(o.label ?? o.key ?? ''),
						points: Number(o.points) || 0
					};
				})
				.filter((t) => t.key)
		: DEFAULT_BINGO_STRUCTURE.tiers;
	return {
		rowCount: Number.isFinite(rowCount) && rowCount > 0 ? Math.floor(rowCount) : DEFAULT_BINGO_STRUCTURE.rowCount,
		rowIntervalHours:
			Number.isFinite(rowIntervalHours) && rowIntervalHours > 0
				? rowIntervalHours
				: DEFAULT_BINGO_STRUCTURE.rowIntervalHours,
		bonusEnabled: r.bonusEnabled !== false,
		tiers: tiers.length ? tiers : DEFAULT_BINGO_STRUCTURE.tiers
	};
}

export const BINGO_BUCKET = 'vs-bingo-proofs';

export const MAX_UPLOAD_BYTES = 10_000_000;
export const MAX_IMAGES_PER_SUBMISSION = 6;
export const ALLOWED_MIME = [
	'image/png',
	'image/jpeg',
	'image/webp',
	'image/gif'
] as const;
