import { error, redirect } from '@sveltejs/kit';
import { isAdmin } from '$lib/server/auth';
import { loadConnect4 } from '$lib/server/connect4';
import { cellLabel, cellId, columnLabel } from '$lib/connect4/rules';
import type { RequestHandler } from './$types';

// The whole game as one Excel-friendly CSV — the "easy overview" an admin skims or
// shares. What it contains depends on where the game is:
//
//   setup           the curated pool: item, boss, EHB, custom-or-generated
//   live/finished   one row per deck slot, column by column: the cell it feeds, the
//                   item, the boss, EHB, and its status — claimed (by whom, when),
//                   ON OFFER now, or still buried in the column
//
// Admin-only, exactly like the tester page: the deck order is the game's only secret.

/** Two decimals is plenty for a spreadsheet skim; '' when a tile has no EHB. */
const ehbCell = (v: number | undefined | null): string =>
	v == null ? '' : String(Math.round(v * 100) / 100);

const esc = (v: unknown): string => {
	const s = v == null ? '' : String(v);
	return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
};
const line = (cells: unknown[]): string => cells.map(esc).join(',');

export const GET: RequestHandler = async ({ locals, params }) => {
	if (!locals.user) throw redirect(303, '/');
	if (!isAdmin(locals.user)) throw error(403, 'Not allowed');
	const game = await loadConnect4(params.slug);
	if (!game) throw error(404, 'No such game');

	const rows: string[] = [];
	if (game.phase === 'setup') {
		rows.push(line(['#', 'Item', 'Boss / source', 'EHB', 'Kind']));
		game.pool.forEach((t, i) => {
			rows.push(line([i + 1, t.item_name, t.source, ehbCell(t.ehb), t.item_id < 0 ? 'custom' : 'generated']));
		});
		// An uncurated game still exports its custom tasks so nothing typed in is lost.
		if (!game.pool.length) {
			for (const t of game.custom) rows.push(line(['', t.item_name, t.source, ehbCell(t.ehb), 'custom']));
		}
	} else {
		const byCell = new Map(game.pieces.map((p) => [cellId(p.col, p.row), p]));
		const nameOf = (side: number) => game.sides[side - 1]?.name ?? `side ${side}`;
		rows.push(line(['Cell', 'Column', 'Item', 'Boss / source', 'EHB', 'Status', 'Claimed by', 'Side', 'Claimed at']));
		for (let col = 0; col < game.cols; col++) {
			const liveIdx = game.live[col]?.deckIdx ?? null;
			for (let row = 0; row < game.rows; row++) {
				const t = game.deck[col * game.rows + row];
				if (!t) continue;
				const p = byCell.get(cellId(col, row));
				const status = p ? 'claimed' : liveIdx === col * game.rows + row ? 'ON OFFER' : 'buried';
				rows.push(
					line([
						cellLabel(cellId(col, row)),
						columnLabel(col),
						t.item_name,
						t.source,
						ehbCell(t.ehb),
						status,
						p?.by_rsn ?? '',
						p ? nameOf(p.side) : '',
						p?.claimed_at ?? ''
					])
				);
			}
		}
	}

	// BOM so Excel opens it as UTF-8 without an import wizard.
	const body = '﻿' + rows.join('\r\n') + '\r\n';
	return new Response(body, {
		headers: {
			'Content-Type': 'text/csv; charset=utf-8',
			'Content-Disposition': `attachment; filename="${game.slug}-tiles.csv"`,
			'Cache-Control': 'no-store'
		}
	});
};
