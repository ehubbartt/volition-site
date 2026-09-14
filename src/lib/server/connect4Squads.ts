import { db } from '$lib/server/db';
import { isAdmin, type SessionUser } from '$lib/server/auth';
import type { Connect4Snapshot } from '$lib/server/connect4';
import { cellId, tileQty, type Side } from '$lib/connect4/rules';
import { squadDefs, UNASSIGNED, type CellShare, type SquadView } from '$lib/connect4/squads';

// The server half of internal teams (the model is in src/lib/connect4/squads.ts; why they
// are "squads" and not "teams" is in db/scripts/connect4_squads.sql).
//
// This module does the two things the pure module cannot: it reads who is on which squad,
// and it works out WHO ACTUALLY BANKED each claimed cell — which on a ×N tile is not the
// player whose name is on the piece but everyone whose drops added up to it.
//
// It is also where the visibility rule lives. The payload is built only for a viewer
// seated on the squads' own side (or an admin); for anyone else this returns null and
// nothing about the clan's internal standings goes over the wire. A server-side omission,
// not a hidden field — the opposing clan cannot read it out of the page source because it
// was never in the response.

function missingColumn(e: unknown): boolean {
	const code = (e as { code?: string } | null)?.code;
	return code === '42703' || code === 'PGRST204';
}

/** Supabase builds an `in` list into the URL, so a 600-cell board is read in bites. */
const CHUNK = 150;

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

export async function buildSquadView(
	snap: Connect4Snapshot,
	viewer: SessionUser
): Promise<SquadView | null> {
	const { data: rows } = await db()
		.from('vs_connect4_squads')
		.select('user_id, squad')
		.eq('event_id', snap.id);

	const assigned = new Map<string, string>();
	for (const r of (rows ?? []) as { user_id: string; squad: string }[]) {
		const key = (r.squad ?? '').trim().toLowerCase();
		if (r.user_id && key) assigned.set(r.user_id, key);
	}
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

	const mine = snap.pieces.filter((p) => p.side === side);

	// Only ×N tiles need their progress read back; a ×1 tile is wholly the claimant's and
	// asks nothing of the database.
	const qtySlots = mine
		.filter((p) => {
			const tile = snap.deck[p.deck_idx];
			return !!tile && tileQty(tile) > 1;
		})
		.map((p) => p.deck_idx);

	// deck slot → user id → qty banked.
	const banked = new Map<number, Map<string, number>>();
	for (let i = 0; i < qtySlots.length; i += CHUNK) {
		const batch = qtySlots.slice(i, i + CHUNK);
		let prog: { deck_idx: number; by_user_id: string | null; qty?: number }[] | null = null;
		let err: unknown = null;
		({ data: prog, error: err } = await db()
			.from('vs_connect4_progress')
			.select('deck_idx, by_user_id, qty')
			.eq('event_id', snap.id)
			.eq('side', side)
			.in('deck_idx', batch));
		// Same fallback the snapshot uses: `qty` post-dates the table, and an install that
		// has not had the column added yet still counts one row as one drop.
		if (missingColumn(err)) {
			({ data: prog } = await db()
				.from('vs_connect4_progress')
				.select('deck_idx, by_user_id')
				.eq('event_id', snap.id)
				.eq('side', side)
				.in('deck_idx', batch));
		}
		for (const r of prog ?? []) {
			if (!r.by_user_id) continue;
			const per = banked.get(r.deck_idx) ?? new Map<string, number>();
			per.set(r.by_user_id, (per.get(r.by_user_id) ?? 0) + (Number(r.qty) || 1));
			banked.set(r.deck_idx, per);
		}
	}

	const cells: Record<string, CellShare[]> = {};
	const seen = new Set<string>();
	for (const p of mine) {
		// Weighted by SQUAD, not by player: two players from one squad on the same tile are
		// one slice of the ring, not two.
		const weights = new Map<string, number>();
		const add = (userId: string | null | undefined, qty: number) => {
			const key = (userId && members[userId]) || UNASSIGNED;
			weights.set(key, (weights.get(key) ?? 0) + qty);
		};

		const per = banked.get(p.deck_idx);
		if (per?.size) {
			for (const [userId, qty] of per) add(userId, qty);
		} else {
			// A ×1 tile, or a ×N tile credited by hand with no progress behind it: the piece
			// names one claimant and they take the whole cell.
			add(p.by_user_id, 1);
		}

		const total = [...weights.values()].reduce((a, b) => a + b, 0);
		if (total <= 0) continue;
		for (const key of weights.keys()) seen.add(key);
		cells[cellId(p.col, p.row)] = [...weights.entries()]
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
