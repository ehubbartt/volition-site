// Player-facing Battleship payload. Thin wrapper over the store whose ONE job is to
// make sure nothing reaches a member that they shouldn't see: every path out of here
// goes through redactFor(), so a raw snapshot (which contains BOTH fleets) can never
// be serialized to a browser.

import { isAdmin, type SessionUser } from '$lib/server/auth';
import {
	loadBattleship,
	maybeAdvancePhase,
	redactFor,
	type BattleshipView
} from '$lib/server/battleship';

export type BattleshipPageResult =
	| { kind: 'not_found' }
	| { kind: 'ok'; game: BattleshipView };

export async function buildBattleshipPage(
	user: SessionUser,
	slug: string
): Promise<BattleshipPageResult> {
	let snap = await loadBattleship(slug);
	if (!snap) return { kind: 'not_found' };

	// Poll-on-read: the placement deadline opens the battle on the next view, so the
	// event moves on without a scheduler (same pattern as personal-board VP settling).
	if (await maybeAdvancePhase(snap)) snap = (await loadBattleship(slug)) ?? snap;

	return { kind: 'ok', game: redactFor(snap, { userId: user.id, isAdmin: isAdmin(user) }) };
}
