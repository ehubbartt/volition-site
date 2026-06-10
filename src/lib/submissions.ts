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
