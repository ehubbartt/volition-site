export type BingoTier = 'skilling' | 'easy' | 'medium' | 'hard' | 'bonus';

export interface BingoTile {
	id: string;
	name: string;
	tier: BingoTier;
	row: number;
	points: number;
	details_html?: string | null;
	img?: string | null;
	color?: string | null;
}

export interface TierMeta {
	key: BingoTier;
	label: string;
	points: number;
	color: string;
}

export const TIERS: TierMeta[] = [
	{ key: 'skilling', label: 'Skilling Tier', points: 1, color: '#3aa6ff' },
	{ key: 'easy', label: 'Easy Tier', points: 2, color: '#5fc35f' },
	{ key: 'medium', label: 'Medium Tier', points: 3, color: '#f0d23c' },
	{ key: 'hard', label: 'Hard Tier', points: 4, color: '#e25656' },
	{ key: 'bonus', label: 'Bonus', points: 5, color: '#ff981f' }
];

export const TIER_BY_KEY: Record<BingoTier, TierMeta> = Object.fromEntries(
	TIERS.map((t) => [t.key, t])
) as Record<BingoTier, TierMeta>;
