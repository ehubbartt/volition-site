// Client-safe board status for the DuoWolf event.
//
// Unlike the bingo board there is NO timed row release — the whole board is
// gated by the event status (plus admin preview), so every visible tile shares
// a single status. Mirrors bingo's TileStatus vocabulary so BoardSubmitModal
// can reuse the same open/past-locked/blurred logic.

export type BoardStatus = 'open' | 'past-locked' | 'blurred';

export function getBoardStatus(
	eventStatus: string | null | undefined,
	admin: boolean
): BoardStatus {
	// A finished event is read-only for everyone.
	if (eventStatus === 'closed' || eventStatus === 'locked') return 'past-locked';
	// A live event is open to everyone (clan-membership/team are checked separately).
	if (eventStatus === 'open') return 'open';
	// draft / preview / unknown: admins preview it as live, everyone else is locked out.
	if (admin) return 'open';
	return 'blurred';
}
