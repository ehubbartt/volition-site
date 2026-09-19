import { db } from '$lib/server/db';
import { isAdmin, type SessionUser } from '$lib/server/auth';
import type { Connect4Snapshot } from '$lib/server/connect4';
import { contributionsBySide } from '$lib/server/connect4Contrib';
import { tileQty, type Side } from '$lib/connect4/rules';
import { computeStats, type Connect4Stats, type StatSubmission } from '$lib/connect4/stats';

// The server half of the post-event report: fetch, then hand it all to the pure scorer
// (src/lib/connect4/stats.ts). Nothing is computed here, deliberately — the report has to
// agree with the standings the browser derives from the same pieces, and the only way to
// guarantee that is for both to go through rules.ts.
//
// Two decisions worth keeping:
//
//  - IT IS ONLY BUILT FOR A FINISHED GAME (the caller enforces that). It reads the whole
//    submission ledger, which a board polling every three seconds must never do.
//  - THE REVIEW DESK IS A SEPARATE FIELD, NOT A HIDDEN SECTION. `admin` is null in a
//    member's payload, so who approved and rejected what never leaves the server for
//    anyone but staff.

const MEMO_TTL_MS = 60_000;
const memo = new Map<string, { at: number; value: Connect4Stats }>();

/** A 600-cell board generates thousands of submissions; PostgREST caps a read at 1000. */
const PAGE = 1000;

type SubRow = {
	user_id: string | null;
	status: string | null;
	submitted_at: string | null;
	reviewed_at: string | null;
	reviewed_by: string | null;
};

async function allSubmissions(eventId: string): Promise<StatSubmission[]> {
	const out: StatSubmission[] = [];
	for (let from = 0; ; from += PAGE) {
		const { data, error } = await db()
			.from('vs_submissions')
			.select('user_id, status, submitted_at, reviewed_at, reviewed_by')
			.eq('event_id', eventId)
			.order('submitted_at', { ascending: true })
			.range(from, from + PAGE - 1);
		// A failed page truncates the report rather than breaking the page; the counts say
		// what they are counting and a short read is visible as an implausibly low total.
		if (error) break;
		const rows = (data ?? []) as SubRow[];
		for (const r of rows) {
			out.push({
				userId: r.user_id,
				status: r.status,
				submittedAt: r.submitted_at,
				reviewedAt: r.reviewed_at,
				reviewedBy: r.reviewed_by
			});
		}
		if (rows.length < PAGE) break;
	}
	return out;
}

export async function buildConnect4Stats(
	snap: Connect4Snapshot,
	viewer: SessionUser
): Promise<Connect4Stats> {
	const staff = isAdmin(viewer);
	// Keyed on staff as well as the event: the two differ by a whole section, and handing
	// a member the cached admin build would leak the review desk.
	const key = `${snap.id}:${staff ? 'admin' : 'member'}`;
	const hit = memo.get(key);
	if (hit && Date.now() - hit.at < MEMO_TTL_MS) return hit.value;

	const [submissions, c1, c2] = await Promise.all([
		allSubmissions(snap.id),
		contributionsBySide(snap, 1),
		contributionsBySide(snap, 2)
	]);

	const reviewerNames = new Map<string, string | null>();
	if (staff) {
		const ids = [...new Set(submissions.map((s) => s.reviewedBy).filter((x): x is string => !!x))];
		if (ids.length) {
			const { data } = await db().from('vs_users').select('id, rsn').in('id', ids);
			for (const u of (data ?? []) as { id: string; rsn: string | null }[]) {
				reviewerNames.set(u.id, u.rsn);
			}
		}
	}

	const value = computeStats({
		pieces: snap.pieces,
		rows: snap.rows,
		cells: snap.deckSize,
		startsAt: snap.startsAt,
		scoring: snap.scoring,
		sides: snap.sides.map((s) => ({
			side: s.side,
			name: s.name,
			color: s.color,
			members: s.members.map((m) => ({ userId: m.userId, rsn: m.rsn }))
		})),
		bonus: snap.bonus.map((b) => ({ side: b.side, points: b.points, byUserId: b.byUserId })),
		shares: { 1: c1, 2: c2 } as Record<Side, Awaited<ReturnType<typeof contributionsBySide>>>,
		submissions,
		qtyOf: (i) => {
			const t = snap.deck[i];
			return t ? tileQty(t) : 1;
		},
		nameOf: (i) => snap.deck[i]?.item_name ?? null,
		reviewerName: (id) => reviewerNames.get(id) ?? null,
		includeAdmin: staff
	});

	memo.set(key, { at: Date.now(), value });
	return value;
}
