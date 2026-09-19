// THE POST-EVENT REPORT — the maths, with no database in sight.
//
// Pure for the same reason squads.ts is: the numbers here have to agree with the ones the
// live board computed in the browser, and the surest way to guarantee that is to score
// with the same functions from rules.ts. It also means the whole report can be asserted
// without a database (scripts/connect4-stats-drill.mjs).
//
// The invariant that matters, and the one the drill exists for: THE PLAYER LEADERBOARD
// ADDS UP TO THE SIDE TOTALS. A report that invented or lost points would sit directly
// under a scoreboard it contradicted, and nobody could tell which half was lying.

import {
	cellId,
	pointsFor,
	standings as computeStandings,
	type Connect4Scoring,
	type Piece,
	type Side
} from './rules';

/** One contributor's slice of one cell — the shape connect4Contrib.ts produces. */
export interface UserShare {
	userId: string | null;
	share: number;
}

export interface StatPlayer {
	userId: string;
	rsn: string | null;
	side: Side;
	submissions: number;
	approved: number;
	rejected: number;
	/** Fractional — half of a ×N tile really is half a tile. */
	tiles: number;
	points: number;
	pets: number;
}

export interface StatSide {
	side: Side;
	name: string;
	color: string;
	players: number;
	/** Players who sent at least one submission — the ones who actually turned up. */
	active: number;
	submissions: number;
	approved: number;
	rejected: number;
	tiles: number;
	points: number;
	pets: number;
	longestLine: number;
}

export interface StatReviewer {
	userId: string;
	rsn: string | null;
	approved: number;
	rejected: number;
	total: number;
	/** Median minutes from submission to decision, over the ones this reviewer settled. */
	medianMinutes: number | null;
}

export interface Connect4Stats {
	submissions: { total: number; approved: number; rejected: number; pending: number };
	board: { claimed: number; cells: number; pets: number; petPoints: number };
	window: { first: string | null; last: string | null };
	sides: StatSide[];
	players: StatPlayer[];
	/** Claims per hour — only hours that saw one. */
	timeline: { hour: string; claims: number }[];
	records: {
		fastestClaim: Claim | null;
		slowestClaim: Claim | null;
		medianClaimMinutes: number | null;
		busiestHour: { hour: string; claims: number } | null;
		biggestQty: { itemName: string | null; qty: number; contributors: number } | null;
		mostContested: { itemName: string | null; cell: string; contributors: number } | null;
		longestLine: { side: Side; len: number } | null;
	};
	/** Staff only — null for everyone else, and absent from their payload entirely. */
	admin: {
		reviewers: StatReviewer[];
		unreviewed: number;
		medianReviewMinutes: number | null;
		resubmitted: number;
	} | null;
}

interface Claim {
	itemName: string | null;
	cell: string;
	rsn: string | null;
	minutes: number;
}

export interface StatSubmission {
	userId: string | null;
	status: string | null;
	submittedAt: string | null;
	reviewedAt: string | null;
	reviewedBy: string | null;
}

export interface StatInput {
	pieces: Piece[];
	rows: number;
	cells: number;
	startsAt: string | null;
	scoring: Connect4Scoring;
	sides: { side: Side; name: string; color: string; members: { userId: string; rsn: string | null }[] }[];
	bonus: { side: Side; points: number; byUserId: string | null }[];
	/** Per side, cell id → who banked it. From connect4Contrib.ts. */
	shares: Record<Side, Record<string, UserShare[]>>;
	submissions: StatSubmission[];
	/** How many drops a deck slot asked for — 1 unless it was a ×N tile. */
	qtyOf: (deckIdx: number) => number;
	nameOf: (deckIdx: number) => string | null;
	reviewerName: (userId: string) => string | null;
	/** Build the review desk. False for a member, and then `admin` is null. */
	includeAdmin: boolean;
}

export const median = (xs: number[]): number | null => {
	if (!xs.length) return null;
	const s = [...xs].sort((a, b) => a - b);
	const m = s.length >> 1;
	return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** The hour bucket a timestamp falls in. Grouped in UTC; the page renders it local. */
const hourOf = (iso: string): string => `${iso.slice(0, 13)}:00:00Z`;

export function computeStats(input: StatInput): Connect4Stats {
	const { pieces, scoring, shares } = input;
	const sharesAt = (side: Side, cell: string): UserShare[] => shares[side]?.[cell] ?? [];

	// ── rosters ──────────────────────────────────────────────────────────────
	const sideOf = new Map<string, Side>();
	const rsnOf = new Map<string, string | null>();
	for (const sd of input.sides) {
		for (const m of sd.members) {
			sideOf.set(m.userId, sd.side);
			rsnOf.set(m.userId, m.rsn);
		}
	}

	// ── the submission ledger ────────────────────────────────────────────────
	const bucket = { total: input.submissions.length, approved: 0, rejected: 0, pending: 0 };
	const perUser = new Map<string, { submissions: number; approved: number; rejected: number }>();
	for (const s of input.submissions) {
		if (s.status === 'approved') bucket.approved++;
		else if (s.status === 'rejected') bucket.rejected++;
		else bucket.pending++;
		if (!s.userId) continue;
		const u = perUser.get(s.userId) ?? { submissions: 0, approved: 0, rejected: 0 };
		u.submissions++;
		if (s.status === 'approved') u.approved++;
		else if (s.status === 'rejected') u.rejected++;
		perUser.set(s.userId, u);
	}

	// ── points, split exactly as the board splits them ───────────────────────
	const runs = computeStandings(pieces, scoring).flatMap((s) => s.runs);
	const pts = new Map<string, number>();
	const tiles = new Map<string, number>();
	const bump = (userId: string | null, points: number, tileShare = 0) => {
		// A claim naming nobody belongs to no player's tally. It still counts for the
		// SIDE — the side totals come from the board, not from summing this map — so the
		// leaderboard can be short of the side total only by genuinely unattributed work.
		if (!userId) return;
		pts.set(userId, (pts.get(userId) ?? 0) + points);
		if (tileShare) tiles.set(userId, (tiles.get(userId) ?? 0) + tileShare);
	};

	for (const p of pieces) {
		for (const s of sharesAt(p.side, cellId(p.col, p.row))) {
			bump(s.userId, (scoring.tile_points || 0) * s.share, s.share);
		}
	}
	for (const run of runs) {
		const per = pointsFor(run.len, scoring) / run.len;
		for (const cell of run.cells) {
			for (const s of sharesAt(run.side, cell)) bump(s.userId, per * s.share);
		}
	}
	const petsPerUser = new Map<string, number>();
	for (const b of input.bonus) {
		if (!b.byUserId) continue;
		petsPerUser.set(b.byUserId, (petsPerUser.get(b.byUserId) ?? 0) + 1);
		bump(b.byUserId, b.points);
	}

	const players: StatPlayer[] = [
		...new Set([...perUser.keys(), ...pts.keys(), ...petsPerUser.keys()])
	]
		.map((userId) => {
			const u = perUser.get(userId) ?? { submissions: 0, approved: 0, rejected: 0 };
			return {
				userId,
				rsn: rsnOf.get(userId) ?? null,
				side: sideOf.get(userId) ?? 1,
				submissions: u.submissions,
				approved: u.approved,
				rejected: u.rejected,
				tiles: tiles.get(userId) ?? 0,
				points: pts.get(userId) ?? 0,
				pets: petsPerUser.get(userId) ?? 0
			};
		})
		.sort((a, b) => b.points - a.points || b.approved - a.approved);

	// ── per side, scored off the BOARD rather than off the leaderboard ───────
	const bonusTotals: Partial<Record<Side, number>> = {};
	for (const b of input.bonus) bonusTotals[b.side] = (bonusTotals[b.side] ?? 0) + b.points;
	const board = computeStandings(pieces, scoring, bonusTotals);
	const sides: StatSide[] = input.sides.map((sd) => {
		const st = board.find((b) => b.side === sd.side);
		const mine = players.filter((p) => p.side === sd.side);
		return {
			side: sd.side,
			name: sd.name,
			color: sd.color,
			players: sd.members.length,
			active: mine.filter((p) => p.submissions > 0).length,
			submissions: mine.reduce((a, p) => a + p.submissions, 0),
			approved: mine.reduce((a, p) => a + p.approved, 0),
			rejected: mine.reduce((a, p) => a + p.rejected, 0),
			tiles: pieces.filter((p) => p.side === sd.side).length,
			points: st?.total ?? 0,
			pets: input.bonus.filter((b) => b.side === sd.side).length,
			longestLine: st?.longest ?? 0
		};
	});

	// ── how long each tile stood before someone took it ──────────────────────
	// The first slot in a column goes up at the start; every other one goes up when the
	// slot below it was claimed. The same derivation the live board used for "up 12m
	// ago", so the report cannot contradict what players were reading at the time.
	const claimedAtOfSlot = new Map<number, string>();
	for (const p of pieces) if (p.claimed_at) claimedAtOfSlot.set(p.deck_idx, p.claimed_at);
	const liveAtOf = (deckIdx: number): number | null => {
		if (deckIdx % input.rows === 0) {
			const t = input.startsAt ? Date.parse(input.startsAt) : NaN;
			return Number.isFinite(t) ? t : null;
		}
		const below = claimedAtOfSlot.get(deckIdx - 1);
		const t = below ? Date.parse(below) : NaN;
		return Number.isFinite(t) ? t : null;
	};

	const perHour = new Map<string, number>();
	const gaps: Claim[] = [];
	for (const p of pieces) {
		if (!p.claimed_at) continue;
		const h = hourOf(p.claimed_at);
		perHour.set(h, (perHour.get(h) ?? 0) + 1);
		const liveAt = liveAtOf(p.deck_idx);
		const at = Date.parse(p.claimed_at);
		// A claim timestamped before its tile went up is a fixed-up row, not a record.
		if (liveAt == null || !Number.isFinite(at) || at < liveAt) continue;
		gaps.push({
			minutes: (at - liveAt) / 60_000,
			itemName: p.item_name ?? null,
			cell: cellId(p.col, p.row),
			rsn: p.by_user_id ? (rsnOf.get(p.by_user_id) ?? null) : null
		});
	}
	gaps.sort((a, b) => a.minutes - b.minutes);
	const timeline = [...perHour.entries()]
		.map(([hour, claims]) => ({ hour, claims }))
		.sort((a, b) => a.hour.localeCompare(b.hour));
	const busiestHour = timeline.reduce<{ hour: string; claims: number } | null>(
		(best, h) => (!best || h.claims > best.claims ? h : best),
		null
	);

	// ── records ──────────────────────────────────────────────────────────────
	let biggestQty: Connect4Stats['records']['biggestQty'] = null;
	let mostContested: Connect4Stats['records']['mostContested'] = null;
	for (const p of pieces) {
		const q = input.qtyOf(p.deck_idx);
		const contributors = sharesAt(p.side, cellId(p.col, p.row)).filter((s) => s.userId).length;
		if (q > 1 && (!biggestQty || q > biggestQty.qty)) {
			biggestQty = { itemName: input.nameOf(p.deck_idx), qty: q, contributors };
		}
		if (!mostContested || contributors > mostContested.contributors) {
			mostContested = { itemName: p.item_name ?? null, cell: cellId(p.col, p.row), contributors };
		}
	}
	const longestLine = board.reduce<{ side: Side; len: number } | null>(
		(best, s) => (s.longest > (best?.len ?? 0) ? { side: s.side, len: s.longest } : best),
		null
	);

	const claimTimes = pieces.map((p) => p.claimed_at).filter((x): x is string => !!x).sort();

	// ── the review desk ──────────────────────────────────────────────────────
	let admin: Connect4Stats['admin'] = null;
	if (input.includeAdmin) {
		const per = new Map<string, { approved: number; rejected: number; mins: number[] }>();
		const allMins: number[] = [];
		for (const s of input.submissions) {
			if (!s.reviewedBy) continue;
			const row = per.get(s.reviewedBy) ?? { approved: 0, rejected: 0, mins: [] };
			if (s.status === 'approved') row.approved++;
			else if (s.status === 'rejected') row.rejected++;
			if (s.submittedAt && s.reviewedAt) {
				const d = (Date.parse(s.reviewedAt) - Date.parse(s.submittedAt)) / 60_000;
				if (Number.isFinite(d) && d >= 0) {
					row.mins.push(d);
					allMins.push(d);
				}
			}
			per.set(s.reviewedBy, row);
		}
		admin = {
			reviewers: [...per.entries()]
				.map(([userId, r]) => ({
					userId,
					rsn: input.reviewerName(userId),
					approved: r.approved,
					rejected: r.rejected,
					total: r.approved + r.rejected,
					medianMinutes: median(r.mins)
				}))
				.sort((a, b) => b.total - a.total),
			// Left in the queue when the game ended: nobody decided it, and it was not
			// approved by some other path.
			unreviewed: input.submissions.filter((s) => !s.reviewedBy && s.status !== 'approved').length,
			medianReviewMinutes: median(allMins),
			// Every submission a player sent beyond the ones that stuck — resubmits after a
			// send-back, plus anything rejected outright.
			resubmitted: [...perUser.values()].reduce((a, u) => a + Math.max(0, u.submissions - u.approved), 0)
		};
	}

	return {
		submissions: bucket,
		board: {
			claimed: pieces.length,
			cells: input.cells,
			pets: input.bonus.length,
			petPoints: input.bonus.reduce((a, b) => a + b.points, 0)
		},
		window: { first: claimTimes[0] ?? null, last: claimTimes[claimTimes.length - 1] ?? null },
		sides,
		players,
		timeline,
		records: {
			fastestClaim: gaps[0] ?? null,
			slowestClaim: gaps[gaps.length - 1] ?? null,
			medianClaimMinutes: median(gaps.map((g) => g.minutes)),
			busiestHour,
			biggestQty,
			// One name on a tile is not a contest.
			mostContested: mostContested && mostContested.contributors > 1 ? mostContested : null,
			longestLine
		},
		admin
	};
}
