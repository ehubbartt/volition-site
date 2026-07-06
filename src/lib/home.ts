// CLIENT-SAFE types for the homepage's streamed data. Built server-side in
// $lib/server/homeData.ts and served as JSON by /api/home, so the page's universal
// load (zero-round-trip navigation) can type its streamed fetches.

export type Member = {
	rsn: string;
	rank: string | null;
	points: number;
	joinedAt: string | null;
	hasProfile: boolean;
};

export type RankBucket = { value: string; label: string; color: string; count: number };

export type TaskSummary = { todoCount: number; total: number; hasActive: boolean };

export type Directory = {
	members: Member[];
	rankBreakdown: RankBucket[];
	recentMembers: Member[];
	memberCount: number;
};

export type Stats = { activeEvents: number; totalEvents: number; packsOpened: number };

export const EMPTY_DIRECTORY: Directory = {
	members: [],
	rankBreakdown: [],
	recentMembers: [],
	memberCount: 0
};

export const EMPTY_STATS: Stats = { activeEvents: 0, totalEvents: 0, packsOpened: 0 };
