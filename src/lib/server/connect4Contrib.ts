import { db } from '$lib/server/db';
import type { Connect4Snapshot } from '$lib/server/connect4';
import { cellId, tileQty, type Side } from '$lib/connect4/rules';

// WHO ACTUALLY BANKED EACH CLAIMED CELL — the one piece of attribution that cannot be
// read off the piece log, extracted here because two features need exactly the same
// answer and must never disagree about it:
//
//   - internal teams (connect4Squads.ts) maps these shares onto squads;
//   - the post-event stats (connect4Stats.ts) maps them onto individual players.
//
// A ×1 tile is wholly its claimant's. A ×N tile is a group effort, so the piece names
// only whoever happened to land the last drop — the real answer is in
// vs_connect4_progress, weighted by the qty each player banked. A ×N tile credited by
// hand has no progress behind it and falls back to the piece's own claimant.
//
// Shares for a cell always sum to 1, which is what lets a caller re-attribute points
// without inventing or losing any.

function missingColumn(e: unknown): boolean {
	const code = (e as { code?: string } | null)?.code;
	return code === '42703' || code === 'PGRST204';
}

/** Supabase builds an `in` list into the URL, so a 600-cell board is read in bites. */
const CHUNK = 150;

export interface UserShare {
	/** Null where nothing names a claimant — a hand-credited piece with no user. */
	userId: string | null;
	share: number;
}

/**
 * Cell id ("col,row") → who banked it, proportionally, for ONE side's pieces.
 *
 * Pass `sides` to do both in one pass; the progress read is per side because the table
 * is keyed that way and the losing side's rows for a slot must never be counted.
 */
export async function contributionsBySide(
	snap: Connect4Snapshot,
	side: Side
): Promise<Record<string, UserShare[]>> {
	const mine = snap.pieces.filter((p) => p.side === side);

	// Only ×N tiles need their progress read back.
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
		// `qty` post-dates the table; an install without the column counts one row as one.
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

	const out: Record<string, UserShare[]> = {};
	for (const p of mine) {
		const weights = new Map<string | null, number>();
		const per = banked.get(p.deck_idx);
		if (per?.size) {
			for (const [userId, qty] of per) weights.set(userId, (weights.get(userId) ?? 0) + qty);
		} else {
			weights.set(p.by_user_id ?? null, 1);
		}
		const total = [...weights.values()].reduce((a, b) => a + b, 0);
		if (total <= 0) continue;
		out[cellId(p.col, p.row)] = [...weights.entries()]
			.map(([userId, w]) => ({ userId, share: w / total }))
			.sort((a, b) => b.share - a.share);
	}
	return out;
}
