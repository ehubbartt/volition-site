import {
	loadPersonalBoard,
	boardResettableAt,
	LOCK_DAYS,
	MIN_SIZE,
	MAX_SIZE,
	MIN_DIFFICULTY,
	MAX_DIFFICULTY
} from './personalBoard';
import type { SessionUser } from './auth';
import itemEhbData from './data/itemEhb.json';
import type { ItemEhb } from '$lib/ehb';

// Builds the personal-bingo page dataset for /api/personal-board. The page has NO
// server load — its universal load fires the fetch without awaiting, so navigating
// there completes instantly and this streams in behind the tile-skeleton grid.

// For the tile-detail modal: look up an item tile's drop-rate string by its board boss.
const ITEM_BY_ID = new Map((itemEhbData as ItemEhb[]).map((i) => [i.id, i]));

export async function buildPersonalBoardData(user: SessionUser) {
	const board = await loadPersonalBoard(user.id);

	// Per-item-tile drop rate (raw "1/N" string) for the tile-detail modal, keyed by tile idx.
	// Matched to the boss shown on the tile (tile.source); doom sources have no rate string.
	const dropRates: Record<number, string> = {};
	if (board) {
		for (const t of board.tiles) {
			if (t.kind !== 'item' || t.item_id == null) continue;
			const src = ITEM_BY_ID.get(t.item_id)?.sources.find((s) => s.s === t.source);
			if (src?.rate) dropRates[t.idx] = src.rate;
		}
	}

	const resettableAt = board?.locked_at ? boardResettableAt(board.locked_at) : null;
	const canReset =
		!board || !board.locked_at || (resettableAt != null && Date.now() >= new Date(resettableAt).getTime());
	return {
		rsn: user.rsn,
		board,
		dropRates,
		locked: !!board?.locked_at,
		resettableAt,
		canReset,
		lockDays: LOCK_DAYS,
		sizeRange: { min: MIN_SIZE, max: MAX_SIZE },
		difficultyRange: { min: MIN_DIFFICULTY, max: MAX_DIFFICULTY }
	};
}
