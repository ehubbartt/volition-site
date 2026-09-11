// CLIENT-SAFE shared types for the generic image-submission + admin-approval
// framework. The unified admin review queue (/admin/submissions) shows one card
// per pending submission group, drawn from three sources:
//   - 'generic' → vs_submissions   (the event-agnostic table; future events)
//   - 'bingo'   → vs_bingo_completions (the legacy solo bingo table)
//   - 'team'    → vs_team_completions  (the legacy per-team table)
// Each source is normalised into a ReviewItem so the UI is identical for all events.
// The server-only loader/decider live in $lib/server/submissions.ts.

export type SubmissionSource = 'generic' | 'bingo' | 'team';
export type SubmissionStatus = 'pending' | 'approved' | 'rejected';
export type ReviewDecision = 'approve' | 'reject';

// One pending submission group (a single (event, submitter/team, task) tuple, with
// every pending proof for it). `source` + `ids` are all the server needs to apply a
// decision: it updates those rows in that source's table.
export interface ReviewItem {
	source: SubmissionSource;
	// 'event'    = a bingo/team/event-scoped proof (needs the pre-approval checklist);
	// 'task'     = a weekly/custom task submission (no checklist);
	// 'personal' = a personal-board manual claim (reviewed, but no WOM-codeword
	//              checklist — personal boards aren't codeword events).
	kind: 'event' | 'task' | 'personal';
	ids: string[]; // the pending row ids this group covers
	event: { id: string; slug: string; name: string };
	submitter: {
		rsn: string | null;
		discord_username: string;
		account_type: string | null;
		clan_label: string | null;
	};
	team: { id: string; name: string | null } | null; // null for solo submissions
	task: { id: string; label: string; detail_html: string | null };
	proofUrls: string[];
	submittedAt: string; // earliest submission in the group
	count: number; // number of proof rows in the group
	quantity: number; // summed claimed quantity (count-based tiles; = count for others)
	// Count-based tiles (e.g. DuoWolf board nodes): the tile's required total and how
	// many the owner has already had APPROVED, so the reviewer sees current X / required.
	// null for tiles that aren't count-based.
	required: number | null;
	approvedSoFar: number | null;
	// FIRST-COME events (Connect Four): when the thing being claimed actually went up.
	// The reviewer's job is to check the drop's in-game time is AFTER this — otherwise a
	// drop from before the tile existed could claim it. null for every other event.
	tileActiveSince: string | null;
	// The column has since moved on: whoever was approved first took this tile, so the
	// submission is for something that is no longer on offer.
	tileSuperseded: boolean;
	// This tile was marked as needing a BEFORE screenshot as well as an after — a counter,
	// a lap total, casket loot, something already banked. An "after" alone proves nothing
	// about what was earned during the event, and by the time a claim reaches the queue
	// nobody can go back and take the missing shot, so the reviewer is told outright.
	tileNeedsPreShot: boolean;
	// What specifically had to be photographed first, when the tile says so.
	tilePreNote: string | null;
	// QUANTITY tiles (Connect Four ×N): what the tile asks for, and where the claimant's
	// side actually stands. Both matter to a reviewer and neither is in `target_label`,
	// which only ever said "covers 1 of 3" — true of the first claim and of the one that
	// finishes the tile alike. `tileBanked` ALREADY includes this claim: a Connect Four
	// claim banks when it is submitted, not when it is approved, which is what makes
	// submission order decide a contested tile.
	tileNeed: number | null;
	tileBanked: number | null;
	tileSideName: string | null;
	// This claim is the one that reached the total and put the piece on the board — the
	// moment a reviewer should look hardest, and previously indistinguishable from any
	// other "covers 1 of 3".
	tileCompletedIt: boolean;
}

// One already-reviewed submission group, for the read-only history view. Same shape
// as ReviewItem plus the decision (status), who reviewed it, when, and any note.
export interface ReviewedItem {
	source: SubmissionSource;
	status: 'approved' | 'rejected';
	ids: string[];
	event: { id: string; slug: string; name: string };
	submitter: {
		rsn: string | null;
		discord_username: string;
		account_type: string | null;
		clan_label: string | null;
	};
	team: { id: string; name: string | null } | null;
	task: { id: string; label: string; detail_html: string | null };
	proofUrls: string[];
	submittedAt: string;
	reviewedAt: string | null;
	reviewer: string | null; // reviewer rsn or discord username
	reviewNote: string | null;
	count: number;
}
