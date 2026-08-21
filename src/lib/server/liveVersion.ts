// The server half of the live-updates pattern (docs/LIVE-UPDATES.md): a cheap token for
// "has anything about this event changed?". Clients poll GET /api/live/[eventId]
// (~100 bytes) and refetch their real board payload only when the token moves, which is
// what makes polling every few seconds affordable regardless of payload size or viewers.
//
// Per kind, the token folds together the row count and latest timestamp of the table the
// board is derived from — so inserts, admin deletes, and delete+insert races all move it —
// plus the event status (and connect4's structure phase) so lifecycle flips propagate too.
// It is an opaque change detector, not a counter: clients only ever compare for equality.
//
// Cost: one small event-row read + one indexed aggregate per compute, memoized per
// instance for MEMO_TTL_MS — however many viewers poll, the DB sees at most ~1 compute
// per second per event. Never throws: a version hiccup must not break a poll loop, so on
// error the token simply doesn't move and the next poll tries again.

import { db } from './db';

const MEMO_TTL_MS = 1000;
const memo = new Map<string, { v: string; at: number }>();

// Count + latest timestamp of an event's rows in one query (count is of the full set,
// the limit only caps returned rows). tsColumn must be indexed with event_id.
async function countAndLatest(table: string, eventId: string, tsColumn: string): Promise<string> {
	const { data, count, error } = await db()
		.from(table)
		.select(tsColumn, { count: 'exact' })
		.eq('event_id', eventId)
		.order(tsColumn, { ascending: false })
		.limit(1);
	if (error) throw new Error(error.message);
	const latest = ((data?.[0] ?? {}) as unknown as Record<string, string | null>)[tsColumn] ?? '';
	return `${count ?? 0}:${latest}`;
}

async function computeVersion(eventId: string): Promise<string> {
	// Selecting the jsonb phase path (rather than `structure`) keeps connect4's undealt
	// 250-entry deck out of the read; on other kinds the alias is just null.
	const { data: ev } = await db()
		.from('vs_events')
		.select('kind, status, phase:structure->connect4->>phase')
		.eq('id', eventId)
		.maybeSingle();
	if (!ev) return 'gone';
	const row = ev as { kind: string; status: string | null; phase: string | null };
	const head = `${row.kind}:${row.status ?? ''}`;
	switch (row.kind) {
		case 'connect4':
			return `${head}:${row.phase ?? ''}:${await countAndLatest('vs_connect4_pieces', eventId, 'claimed_at')}`;
		case 'battleship':
			return `${head}:${await countAndLatest('vs_battleship_shots', eventId, 'fired_at')}`;
		case 'bingo': {
			// Completions carry a review status, so also fold in the approved count —
			// an approve/reject flip changes the board without adding a row.
			const [all, approved] = await Promise.all([
				countAndLatest('vs_bingo_completions', eventId, 'submitted_at'),
				db()
					.from('vs_bingo_completions')
					.select('id', { count: 'exact', head: true })
					.eq('event_id', eventId)
					.eq('status', 'approved')
			]);
			return `${head}:${all}:${approved.count ?? 0}`;
		}
		default:
			// Kinds without a live board yet still get a token that moves on lifecycle
			// changes, so pages may opt in before their kind grows a dedicated arm.
			return head;
	}
}

export async function liveVersion(eventId: string): Promise<string> {
	const hit = memo.get(eventId);
	if (hit && Date.now() - hit.at < MEMO_TTL_MS) return hit.v;
	let v: string;
	try {
		v = await computeVersion(eventId);
	} catch {
		v = hit?.v ?? '0';
	}
	memo.set(eventId, { v, at: Date.now() });
	return v;
}
