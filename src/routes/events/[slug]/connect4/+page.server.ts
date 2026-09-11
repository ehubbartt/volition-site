import { fail, redirect } from '@sveltejs/kit';
import { createSubmission } from '$lib/server/submissions';
import {
	claimTile,
	hasOpened,
	loadConnect4,
	pendingPieceOf,
	repointPendingPiece,
	sideForUser
} from '$lib/server/connect4';
import { columnLabel } from '$lib/connect4/rules';
import type { Actions } from './$types';

// The page itself is instant-nav (no server load — see +page.ts and docs/PAGES.md).
// This file exists only for the member's own CLAIM SUBMISSION.
//
// Connect Four is run entirely on manual proof: a member submits a screenshot for the
// column they got the drop for, and it lands in the generic /admin/submissions queue
// like every other event's proof. Nothing is credited here — approval does that, so
// two people submitting the same tile is a race an admin settles, not a database one.
//
// Why proof-and-review rather than the Dink auto-credit this event used to use: a
// clan-vs-clan event where only one side has the plugin set up is not a fair race.

export const actions: Actions = {
	submitClaim: async ({ request, locals, params }) => {
		if (!locals.user) throw redirect(303, '/');

		const game = await loadConnect4(params.slug);
		if (!game) return fail(404, { error: 'No such game' });
		if (game.phase !== 'live') return fail(400, { error: 'This game is not running' });
		// Dealt, but the clock has not reached the announced start. Refused HERE rather than
		// at review: 240 players sending proof into a queue that will only reject it is a
		// mess for everyone, and the board is showing no tiles to claim against anyway.
		if (!hasOpened(game)) {
			return fail(400, { error: `This game opens at ${new Date(game.startsAt ?? '').toLocaleString()}.` });
		}

		// A member who is signed up but not seated has no side to claim FOR — the same
		// rule the drop pipeline applies. Never guessed.
		const side = await sideForUser(game.id, locals.user.id);
		if (!side) return fail(403, { error: "You're not on a side in this game yet." });

		const form = await request.formData();
		const col = Number(form.get('col'));
		if (!Number.isInteger(col)) return fail(400, { error: 'Pick a column.' });

		// A RESUBMIT is for the tile they already hold, not for whatever the column is
		// offering now. Their pending piece took that slot and the column moved on, so
		// "click column K and send another" was pointing at a different tile — the proof
		// would have been filed against the wrong objective.
		const redo = form.get('resubmit') === '1' ? await pendingPieceOf(game.id, col, locals.user.id) : null;
		const slot = redo
			? { deckIdx: redo.deck_idx, tile: game.deck[redo.deck_idx] ?? null }
			: game.live[col];
		if (!slot?.tile) {
			return fail(400, {
				error: redo
					? 'That claim is no longer waiting on you.'
					: 'That column has nothing on offer.'
			});
		}

		const files = form.getAll('proof').filter((f): f is File => f instanceof File && f.size > 0);
		if (files.length === 0) return fail(400, { error: 'Add a screenshot showing the drop' });

		// target_id carries the column AND the deck slot it was on offer for. The slot is
		// what makes a stale submission detectable: if the column moves on before an admin
		// reviews, the row still says which tile was actually being claimed.
		// How many of a ×N tile's requirement this one proof covers. People misread
		// multi-drop tiles and send a single drop, so the form asks outright and the
		// number rides along to the reviewer (the queue already sums approved quantities).
		const need = Math.max(1, Number(slot.tile.qty ?? 1));
		const claimed = Math.min(need, Math.max(1, Number(form.get('quantity')) || 1));

		const result = await createSubmission({
			eventId: game.id,
			userId: locals.user.id,
			targetId: `c4:${col}:${slot.deckIdx}`,
			targetLabel:
				`${slot.tile.item_name} — column ${columnLabel(col)}` +
				(need > 1 ? ` (covers ${claimed} of ${need})` : ''),
			quantity: claimed,
			files
		});
		if (!result.ok) return fail(400, { error: result.error });

		// Already holding this column from a partial rejection? Then this is a better
		// screenshot for the claim they never lost — keep the piece, point it at the new
		// proof. Claiming again would fail, since they are standing on the cell.
		if (await repointPendingPiece(game.id, col, locals.user.id, result.id)) {
			return { submitted: true, col, resubmitted: true };
		}

		// Place the piece PROVISIONALLY. Submission order is what settles a contested
		// tile — if the piece only landed on approval, whoever an admin happened to
		// review first would win, which is not the race the players are running.
		const claim = await claimTile({
			eventId: game.id,
			side,
			col,
			dropKey: `manual:submission:${result.id}`,
			byUserId: locals.user.id,
			status: 'pending',
			submissionId: result.id,
			// How many of a ×N tile's requirement this proof covers. WITHOUT this a single
			// submission completed a thousand-drop tile: the claim named a column, and the
			// quantity gate used to treat that as an admin deciding the tile.
			covers: claimed
		});
		// A ×N tile that the side has not finished yet: the drops are banked, no piece is
		// placed, and the column keeps offering the tile. Not a failure — say where they are.
		if (claim.status === 'progress') {
			return { submitted: true, col, progress: { have: claim.have ?? 0, need: claim.need ?? 0 } };
		}
		if (claim.status !== 'claimed') {
			// Someone beat them to it between picking the column and submitting. The proof
			// row stays for an admin to see, but nothing was placed.
			return { submitted: true, col, tileTaken: true };
		}

		return { submitted: true, col, cell: claim.cell };
	}
};
