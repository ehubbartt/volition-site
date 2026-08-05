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

export type RankBucket = {
	value: string;
	label: string;
	color: string;
	count: number;
	// Subset of `count` whose TempleOSRS collection log isn't linked — they can't be fully
	// scored (gear + clog read 0), so they pile up at the bottom. Rendered as a lighter shade
	// so the real spread of scored members stands out.
	noTempleCount: number;
	// Badge image override (signature/prestige ranks carry their own art; ladder ranks
	// resolve theirs from rankImg). Null → the client falls back to a colour dot.
	img?: string | null;
};

export type TaskSummary = { todoCount: number; total: number; hasActive: boolean };

export type Directory = {
	members: Member[];
	rankBreakdown: RankBucket[];
	recentMembers: Member[];
	memberCount: number;
};

export type Stats = { activeEvents: number; totalEvents: number; packsOpened: number };
