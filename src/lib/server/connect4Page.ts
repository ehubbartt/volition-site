import type { SessionUser } from '$lib/server/auth';
import {
	DECK_SIZE,
	loadConnect4,
	redactSnapshot,
	type Connect4Snapshot
} from '$lib/server/connect4';
import { maybeProcessDinkDrops } from '$lib/server/dinkDrops';
import { liveVersion } from '$lib/server/liveVersion';
import type { Connect4Scoring, LiveTile, Piece, Side } from '$lib/connect4/rules';

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
	startsAt: string | null;
	endsAt: string | null;
	sides: Connect4ViewSide[];
	pieces: Piece[];
	live: (LiveTile | null)[];
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
			winner: r.winner,
			full: r.full,
			deckSize: DECK_SIZE,
			viewerSide
		}
	};
}
