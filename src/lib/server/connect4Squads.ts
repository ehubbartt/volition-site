import { db } from '$lib/server/db';
import { isAdmin, type SessionUser } from '$lib/server/auth';
import type { Connect4Snapshot } from '$lib/server/connect4';
import { contributionsBySide } from '$lib/server/connect4Contrib';
import type { Side } from '$lib/connect4/rules';
import { squadDefs, UNASSIGNED, type CellShare, type SquadView } from '$lib/connect4/squads';

// The server half of internal teams (the model is in src/lib/connect4/squads.ts; why they
// are "squads" and not "teams" is in db/scripts/connect4_squads.sql).
//
// Who banked each cell is NOT worked out here — that lives in connect4Contrib.ts, because
// the post-event stats need exactly the same answer and the two must never disagree. This
// module only maps those per-player shares onto squads.
//
// It is where the visibility rule lives. The payload is built only for a viewer seated on
// the squads' own side (or an admin); for anyone else this returns null and nothing about
// the clan's internal standings goes over the wire. A server-side omission, not a hidden
// field — the opposing clan cannot read it out of the page source because it was never in
// the response.

/**
 * Which side the squads belong to: whichever holds the most assigned players. Derived
 * rather than configured because it then cannot drift — seat one squad member on the
 * wrong side and the answer is still the side the clan is actually sitting on.
 */
function squadSide(snap: Connect4Snapshot, assigned: Map<string, string>): Side | null {
	let best: { side: Side; n: number } | null = null;
	for (const sd of snap.sides) {
		let n = 0;
		for (const m of sd.members) if (assigned.has(m.userId)) n++;
		if (n > 0 && (!best || n > best.n)) best = { side: sd.side, n };
	}
	return best?.side ?? null;
}

/** Squad assignments for an event, keyed by user id. Empty when the game has none. */
export async function loadSquadRoster(eventId: string): Promise<Map<string, string>> {
	const { data } = await db()
		.from('vs_connect4_squads')
		.select('user_id, squad')
		.eq('event_id', eventId);
	const out = new Map<string, string>();
	for (const r of (data ?? []) as { user_id: string; squad: string }[]) {
		const key = (r.squad ?? '').trim().toLowerCase();
		if (r.user_id && key) out.set(r.user_id, key);
	}
	return out;
}

export async function buildSquadView(
	snap: Connect4Snapshot,
	viewer: SessionUser
): Promise<SquadView | null> {
	const assigned = await loadSquadRoster(snap.id);
	// No squads on this game — every other board carries on exactly as it was.
	if (!assigned.size) return null;

	const side = squadSide(snap, assigned);
	if (!side) return null;

	// THE GATE. One side's internal split is that side's own business.
	const seat = snap.sides.find((s) => s.members.some((m) => m.userId === viewer.id))?.side ?? null;
	if (seat !== side && !isAdmin(viewer)) return null;

	// Everyone on the side, so an unassigned player is a visible gap rather than a missing
	// row — and so the squad totals add back up to what the side's scoreboard says.
	const members: Record<string, string> = {};
	for (const m of snap.sides.find((s) => s.side === side)?.members ?? []) {
		members[m.userId] = assigned.get(m.userId) ?? UNASSIGNED;
	}

	const byUser = await contributionsBySide(snap, side);

	const cells: Record<string, CellShare[]> = {};
	const seen = new Set<string>();
	for (const [cell, shares] of Object.entries(byUser)) {
		// Re-weighted by SQUAD, not by player: two players from one squad on the same tile
		// are one slice of the ring, not two.
		const weights = new Map<string, number>();
		for (const s of shares) {
			const key = (s.userId && members[s.userId]) || UNASSIGNED;
			weights.set(key, (weights.get(key) ?? 0) + s.share);
		}
		const total = [...weights.values()].reduce((a, b) => a + b, 0);
		if (total <= 0) continue;
		for (const key of weights.keys()) seen.add(key);
		cells[cell] = [...weights.entries()]
			.map(([key, w]) => ({ key, share: w / total }))
			.sort((a, b) => b.share - a.share);
	}

	// Every squad with a roster, plus any that shows up only in the contributions — a
	// player assigned a squad and then moved off the side still banked what they banked.
	// The unassigned bucket is not a squad; the scorer adds it.
	const keys = [
		...new Set(
			[...Object.values(members), ...seen, ...assigned.values()].filter((k) => k !== UNASSIGNED)
		)
	].sort();

	return {
		side,
		squads: squadDefs(keys),
		cells,
		members,
		viewerSquad: members[viewer.id] || null
	};
}
