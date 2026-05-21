import { BINGO_ROW_COUNT, BINGO_ROW_INTERVAL_HOURS } from './config';
import type { BingoTile } from './tiles';

export type BingoStatus = 'pre' | 'active' | 'ended';

export interface BingoState {
	status: BingoStatus;
	startAt: Date | null;
	endsAt: Date | null;
	activeRow: number | null;
	rowsReleased: number;
	nextRowAt: Date | null;
	msUntilNextRow: number | null;
	msUntilStart: number | null;
}

const HOUR_MS = 3_600_000;
const ROW_MS = BINGO_ROW_INTERVAL_HOURS * HOUR_MS;
const TOTAL_MS = BINGO_ROW_COUNT * ROW_MS;

export function getBingoState(
	startIso: string | null | undefined,
	now: Date = new Date()
): BingoState {
	if (!startIso) {
		return {
			status: 'pre',
			startAt: null,
			endsAt: null,
			activeRow: null,
			rowsReleased: 0,
			nextRowAt: null,
			msUntilNextRow: null,
			msUntilStart: null
		};
	}
	const startAt = new Date(startIso);
	const endsAt = new Date(startAt.getTime() + TOTAL_MS);
	const elapsed = now.getTime() - startAt.getTime();

	if (elapsed < 0) {
		return {
			status: 'pre',
			startAt,
			endsAt,
			activeRow: null,
			rowsReleased: 0,
			nextRowAt: startAt,
			msUntilNextRow: -elapsed,
			msUntilStart: -elapsed
		};
	}

	if (elapsed >= TOTAL_MS) {
		return {
			status: 'ended',
			startAt,
			endsAt,
			activeRow: null,
			rowsReleased: BINGO_ROW_COUNT,
			nextRowAt: null,
			msUntilNextRow: null,
			msUntilStart: null
		};
	}

	const activeRow = Math.floor(elapsed / ROW_MS);
	const nextRowAt = new Date(startAt.getTime() + (activeRow + 1) * ROW_MS);

	return {
		status: 'active',
		startAt,
		endsAt,
		activeRow,
		rowsReleased: activeRow + 1,
		nextRowAt,
		msUntilNextRow: nextRowAt.getTime() - now.getTime(),
		msUntilStart: 0
	};
}

export type TileStatus = 'open' | 'past-locked' | 'blurred';

export function getTileStatus(tile: BingoTile, state: BingoState): TileStatus {
	if (state.status === 'pre') return 'blurred';
	if (state.status === 'ended') return 'past-locked';
	if (state.activeRow === null) return 'blurred';
	const idx = tile.row - 1;
	if (idx <= state.activeRow) return 'open';
	return 'blurred';
}

export function isTileOpen(tile: BingoTile, state: BingoState): boolean {
	return getTileStatus(tile, state) === 'open';
}

export function formatCountdown(ms: number | null | undefined): string {
	if (ms == null || ms <= 0) return '0h 00m';
	const totalMinutes = Math.ceil(ms / 60_000);
	const days = Math.floor(totalMinutes / (60 * 24));
	const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
	const mins = totalMinutes % 60;
	if (days > 0) return `${days}d ${hours}h ${String(mins).padStart(2, '0')}m`;
	return `${hours}h ${String(mins).padStart(2, '0')}m`;
}
