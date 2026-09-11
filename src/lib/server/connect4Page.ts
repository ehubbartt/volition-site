import type { SessionUser } from '$lib/server/auth';
import {
	loadConnect4,
	redactSnapshot,
	type BonusAward,
	type Connect4Snapshot
} from '$lib/server/connect4';
import { maybeProcessDinkDrops } from '$lib/server/dinkDrops';
import { liveVersion } from '$lib/server/liveVersion';
import { db } from '$lib/server/db';
import { cellId, type Connect4Scoring, type LiveTile, type Piece, type Side } from '$lib/connect4/rules';

// Builds the payload for the MEMBER board page (/events/[slug]/connect4) — the spectator
// view of a game the admin tester drives. Everything here is public to a signed-in member:
// this is a shared board and both sides watch the same race. Two things are deliberately
// NOT in the payload:
//
//  - the undealt deck and the pool (redactSnapshot): knowing what a column offers next is
//    worth real points, so only the 25 tiles currently on offer ever leave the server;
//  - members' Discord ids: the page shows rosters by RSN, and a spectator payload has no
//    business carrying every player's Discord id along for the ride.

export interface Connect4ViewSide {
	side: Side;
	name: string;
	color: string;
	members: { userId: string; rsn: string | null }[];
}

export interface Connect4View {
	id: string;
	slug: string;
	name: string;
	description: string | null;
	phase: Connect4Snapshot['phase'];
	test: boolean;
	scoring: Connect4Scoring;
	cols: number;
	rows: number;
	startsAt: string | null;
	endsAt: string | null;
	sides: Connect4ViewSide[];
	pieces: Piece[];
	live: (LiveTile | null)[];
	/** Awards beside the board — scores are public, so members see these too. */
	bonus: BonusAward[];
	/** Claims placed but not yet reviewed, newest first — the board's waiting room. */
	awaiting: {
		cell: string;
		col: number;
		/** The deck slot the claim is for — the tile they actually hold, not the column's
		 *  current one, which has moved on. */
		deckIdx: number;
		itemName: string | null;
		side: Side;
		rsn: string | null;
		at: string;
		/** Set when this is the viewer's own claim that was sent back for better proof. */
		needsBetterProof: boolean;
		/**
		 * The tile this claim is FOR, on the viewer's own send-back rows only. The column
		 * has already moved on to its next tile, so the resubmit panel cannot read it off
		 * `live` — and it still needs to show the qty, the group members and the
		 * before-screenshot warning that belong to the tile actually held.
		 */
		tile: LiveTile['tile'] | null;
		note: string | null;
	}[];
	winner: Side | null;
	full: boolean;
	deckSize: number;
	/** The side the viewer is seated on, or null for a pure spectator. */
	viewerSide: Side | null;
}

export type Connect4PageResult =
	| { kind: 'not_found' }
	| { kind: 'ok'; live: string; game: Connect4View };

export async function buildConnect4Page(
	user: SessionUser,
	slug: string
): Promise<Connect4PageResult> {
	let snap = await loadConnect4(slug);
	if (!snap) return { kind: 'not_found' };

	// Poll-on-read, the house backstop (docs/LIVE-UPDATES.md): a member opening or
	// refreshing the board nudges the drop consumer, so a queued Dink drop lands even if
	// the proxy's after-insert ping never arrived. Throttled inside, so a busy board
	// doesn't turn every version-poll refetch into a drain.
	if (snap.phase === 'live') {
		await maybeProcessDinkDrops();
		snap = (await loadConnect4(slug)) ?? snap;
	}

	const r = redactSnapshot(snap, false);
	const viewerSide =
		r.sides.find((s) => s.members.some((m) => m.userId === user.id))?.side ?? null;

	// The waiting room: pieces on the board that nobody has reviewed yet. Public, because
	// the whole point is that both clans can see what is contested and what is settled.
	// A rejection note is only ever shown to the person it was written for.
	const pendingPieces = r.pieces.filter((p) => p.status === 'pending');
	const notesBySubmission = new Map<string, string | null>();
	const subIds = pendingPieces.map((p) => p.submission_id).filter((x): x is string => !!x);
	if (subIds.length) {
		const { data } = await db()
			.from('vs_submissions')
			.select('id, status, review_note, user_id')
			.in('id', subIds);
		for (const row of (data ?? []) as Array<{
			id: string;
			status: string;
			review_note: string | null;
			user_id: string | null;
		}>) {
			// 'rejected' on a piece that is STILL STANDING is a partial rejection: the
			// evidence was sent back but the tile was never taken away.
			if (row.status === 'rejected' && row.user_id === user.id) {
				notesBySubmission.set(row.id, row.review_note ?? '');
			}
		}
	}

	const rsnByUser = new Map<string, string | null>();
	for (const sd of r.sides) for (const m of sd.members) rsnByUser.set(m.userId, m.rsn);

	const awaiting = pendingPieces
		.slice()
		.sort((a, b) => (b.claimed_at ?? '').localeCompare(a.claimed_at ?? ''))
		.map((p) => ({
			cell: cellId(p.col, p.row),
			col: p.col,
			deckIdx: p.deck_idx,
			itemName: p.item_name ?? null,
			side: p.side,
			rsn: p.by_user_id ? (rsnByUser.get(p.by_user_id) ?? null) : null,
			at: p.claimed_at ?? '',
			needsBetterProof: !!p.submission_id && notesBySubmission.has(p.submission_id),
			tile:
				!!p.submission_id && notesBySubmission.has(p.submission_id)
					? (snap.deck[p.deck_idx] ?? null)
					: null,
			note: p.submission_id ? (notesBySubmission.get(p.submission_id) ?? null) : null
		}));

	return {
		kind: 'ok',
		// Baseline for the page's live poll, computed alongside the payload so a change
		// landing between render and the first poll is still caught.
		live: await liveVersion(r.id),
		game: {
			id: r.id,
			slug: r.slug,
			name: r.name,
			description: r.description,
			phase: r.phase,
			test: r.test,
			scoring: r.scoring,
			cols: r.cols,
			rows: r.rows,
			startsAt: r.startsAt,
			endsAt: r.endsAt,
			sides: r.sides.map((s) => ({
				side: s.side,
				name: s.name,
				color: s.color,
				members: s.members.map((m) => ({ userId: m.userId, rsn: m.rsn }))
			})),
			pieces: r.pieces,
			live: r.live,
			bonus: r.bonus,
			awaiting,
			winner: r.winner,
			full: r.full,
			deckSize: r.deckSize,
			viewerSide
		}
	};
}
