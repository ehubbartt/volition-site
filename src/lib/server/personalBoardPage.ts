import {
	loadPersonalBoard,
	settlePersonalVp,
	personalVpAmounts,
	boardResettableAt,
	RESET_COOLDOWN_DAYS,
	RESET_COOLDOWN_ENABLED,
	MIN_SIZE,
	MAX_SIZE,
	MIN_DIFFICULTY,
	MAX_DIFFICULTY,
	type PersonalVpState
} from './personalBoard';
import type { SessionUser } from './auth';
import itemEhbData from './data/itemEhb.json';
import itemEhcData from './data/itemEhc.json';
import type { ItemEhb, ItemEhc } from '$lib/ehb';
import { maybeProcessDinkDrops } from './dinkDrops';

// Builds the personal-bingo page dataset for /api/personal-board. The page has NO
// server load — its universal load fires the fetch without awaiting, so navigating
// there completes instantly and this streams in behind the tile-skeleton grid.

// For the tile-detail modal: look up an item tile's drop-rate string by its board boss.
const ITEM_BY_ID = new Map((itemEhbData as ItemEhb[]).map((i) => [i.id, i]));

// Non-boss (Temple EHC) item ids — the page re-seeds its "include non-PVM collection
// log" toggle from whether any board tile came from this pool (tiles carry no marker).
const EHC_IDS = new Set((itemEhcData as ItemEhc[]).map((i) => i.id));

export async function buildPersonalBoardData(user: SessionUser) {
	// Poll-on-read backstop (same as the event bingo board): drain any recorded Dink
	// drops so tiles credited since the last visit show up on this load. Fire-and-forget
	// + throttled inside; without this, personal-board credits waited for someone to
	// open an event board or the cron endpoint.
	maybeProcessDinkDrops();

	const board = await loadPersonalBoard(user.id);

	// Settle VP for any newly-completed lines/blackout (idempotent, CAS-guarded), and
	// surface the board's reward amounts for display. Draft boards preview the amounts.
	let vp: PersonalVpState | null = null;
	if (board) {
		vp = await settlePersonalVp(
			{ id: user.id, discord_id: user.discord_id, rsn: user.rsn },
			board
		).catch((e) => {
			console.warn('[personalBoard] vp settle failed:', e instanceof Error ? e.message : e);
			return { ...personalVpAmounts(board.size, board.difficulty), earned: 0, test: false };
		});
	}

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

	// Reset-cooldown surface: resettableAt is null while the cooldown is disabled or the
	// board is a draft; resetDays is null while disabled (the UI keys its copy off it).
	const resettableAt = board?.locked_at ? boardResettableAt(board.locked_at) : null;
	const canReset = resettableAt == null || Date.now() >= new Date(resettableAt).getTime();
	return {
		rsn: user.rsn,
		board,
		vp,
		dropRates,
		includesClogItems:
			board?.tiles.some((t) => t.kind === 'item' && t.item_id != null && EHC_IDS.has(t.item_id)) ?? false,
		locked: !!board?.locked_at,
		resettableAt,
		canReset,
		resetDays: RESET_COOLDOWN_ENABLED ? RESET_COOLDOWN_DAYS : null,
		sizeRange: { min: MIN_SIZE, max: MAX_SIZE },
		difficultyRange: { min: MIN_DIFFICULTY, max: MAX_DIFFICULTY }
	};
}
