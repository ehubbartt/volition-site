import { db } from './db';
import { microCached } from './microCache';
import { markdownPreview } from '$lib/markdown';
import {
	BINGO_EVENT_SLUG,
	BINGO_ROW_COUNT,
	BINGO_ROW_INTERVAL_HOURS
} from '$lib/bingo/config';
import type { EventSections, EventListItem, PersonalCard, Section, ActionLine } from '$lib/eventsList';

// Builds the /events list (active/upcoming/past sections + the Personal Bingo card
// state) for one user. Served as JSON by /api/events-list so the page's universal
// load can navigate with zero server round-trips and stream this in behind skeletons.

const HOUR_MS = 3_600_000;
const BINGO_DURATION_MS = BINGO_ROW_COUNT * BINGO_ROW_INTERVAL_HOURS * HOUR_MS;
const FAR = Number.MAX_SAFE_INTEGER;

function startsAtFor(slug: string, starts: string | null, opens: string | null): string | null {
	return starts ?? (slug === BINGO_EVENT_SLUG ? opens : null);
}

function endsAtFor(
	slug: string,
	startsAt: string | null,
	endsAt: string | null,
	closes: string | null
): string | null {
	if (endsAt) return endsAt;
	if (slug === BINGO_EVENT_SLUG && startsAt) {
		return new Date(new Date(startsAt).getTime() + BINGO_DURATION_MS).toISOString();
	}
	return closes;
}

interface EventRow {
	id: string;
	slug: string;
	name: string;
	kind: string;
	description: string | null;
	status: string;
	signup_opens_at: string | null;
	signup_closes_at: string | null;
	starts_at: string | null;
	ends_at: string | null;
}

// Only duo (and signup-configured custom) events use the signup flow. bingo/simple/
// sequential are solo — even if a bingo borrows signup_opens_at as its start alias.
function hasSignupFlow(ev: EventRow): boolean {
	return (
		ev.kind === 'duo' ||
		(ev.kind === 'custom' && (ev.signup_opens_at != null || ev.signup_closes_at != null))
	);
}

// Classify an event FOR THE CURRENT USER: which section it belongs in, a sort key
// (ascending = the soonest thing the user needs to act on comes first), and the line
// to display. "Action" = the next step for this user: submit before it ends, sign up
// before signups close, or just wait for it to start. For signup events this depends
// on whether the user is already signed up (then it's about the start, not signups).
function classify(
	ev: EventRow,
	startsAt: string | null,
	endsAt: string | null,
	now: number,
	signedUp: boolean
): { section: Section; sortKey: number; line: ActionLine | null } {
	const startMs = startsAt ? new Date(startsAt).getTime() : null;
	const endMs = endsAt ? new Date(endsAt).getTime() : null;
	const sOpen = ev.signup_opens_at ? new Date(ev.signup_opens_at).getTime() : null;
	const sClose = ev.signup_closes_at ? new Date(ev.signup_closes_at).getTime() : null;

	// Closed → past, most-recently-ended first.
	if (ev.status === 'closed') {
		return {
			section: 'past',
			sortKey: -(endMs ?? startMs ?? 0),
			line: endsAt ? { label: 'Ended', date: endsAt } : null
		};
	}

	// Admin-only pre-launch states aren't live yet → upcoming.
	if (ev.status === 'draft' || ev.status === 'preview') {
		return {
			section: 'upcoming',
			sortKey: startMs ?? FAR,
			line: startsAt ? { label: 'Starts', date: startsAt } : null
		};
	}

	// Explicitly ended: an open/locked event whose own end time has passed but an admin
	// hasn't flipped it to 'closed' yet → treat as past, not active. Uses the event's
	// OWN ends_at (not the computed `endMs`), so bingo — which has no explicit end and
	// stays open until manually closed — is unaffected.
	const explicitEndMs = ev.ends_at ? new Date(ev.ends_at).getTime() : null;
	if (explicitEndMs != null && !Number.isNaN(explicitEndMs) && now > explicitEndMs) {
		return {
			section: 'past',
			sortKey: -explicitEndMs,
			line: { label: 'Ended', date: ev.ends_at }
		};
	}

	const started = startMs == null || now >= startMs; // open + past its start = live

	// Signup event the user HASN'T joined → the action is about signing up.
	if (hasSignupFlow(ev) && !signedUp) {
		const signupsOpen = (sOpen == null || now >= sOpen) && (sClose == null || now <= sClose);
		if (signupsOpen) {
			return {
				section: 'active',
				sortKey: sClose ?? endMs ?? FAR,
				line: ev.signup_closes_at
					? { label: 'Sign up by', date: ev.signup_closes_at }
					: { label: 'Sign up now', date: null }
			};
		}
		if (sOpen != null && now < sOpen) {
			return {
				section: 'upcoming',
				sortKey: sOpen,
				line: { label: 'Signups open', date: ev.signup_opens_at }
			};
		}
		// Signups have closed and they never joined — nothing to act on.
		if (started) {
			return {
				section: 'active',
				sortKey: endMs ?? FAR,
				line: endsAt ? { label: 'Ends', date: endsAt } : { label: 'Running', date: null }
			};
		}
		return {
			section: 'upcoming',
			sortKey: startMs ?? FAR,
			line: startsAt ? { label: 'Starts', date: startsAt } : null
		};
	}

	// Solo event, OR a signup event the user is already in → it's about the event itself.
	if (started) {
		return {
			section: 'active',
			sortKey: endMs ?? FAR,
			line: endsAt ? { label: 'Ends', date: endsAt } : { label: 'Open now', date: null }
		};
	}
	return {
		section: 'upcoming',
		sortKey: startMs ?? FAR,
		line: startsAt ? { label: 'Starts', date: startsAt } : null
	};
}

export async function buildSections(userId: string, admin: boolean): Promise<EventSections> {
	const visibleStatuses = admin
		? ['draft', 'preview', 'open', 'locked', 'closed']
		: ['open', 'locked', 'closed'];

	// Tasks live in vs_tasks (their own table / the To Do page), so vs_events is
	// only "full events" here — no task filtering needed.
	const [events, { data: sus }, { data: pb }] = await Promise.all([
		// The event list itself is identical for every viewer (per admin visibility)
		// → micro-cached; admin event mutations bust 'events:list'. The signup +
		// personal-board reads below are per-user and stay live. Throw INSIDE the
		// cached fn so a transient DB error isn't cached as a 500 for the whole TTL.
		microCached(`events:list:${admin}`, 15_000, async () => {
			const { data, error } = await db()
				.from('vs_events')
				.select(
					'id, slug, name, kind, description, status, signup_opens_at, signup_closes_at, starts_at, ends_at'
				)
				.neq('kind', 'personal') // exclude personal boards (owner-scoped, not public events)
				.in('status', visibleStatuses)
				.neq('slug', 'weekly-tasks'); // internal task container, not a real event
			if (error) throw new Error(error.message);
			return (data ?? []) as EventRow[];
		}),
		// Which events the current user has signed up for (signup events only) — drives
		// the signed-up vs not-signed-up sorting/display.
		db().from('vs_event_signups').select('event_id').eq('user_id', userId),
		// The caller's own personal board (if any) for the Personal Bingo card.
		db()
			.from('vs_events')
			.select('id, locked_at')
			.eq('kind', 'personal')
			.eq('owner_user_id', userId)
			.maybeSingle()
	]);

	let personal: PersonalCard = { state: 'none' };
	if (pb) {
		if (!pb.locked_at) {
			personal = { state: 'draft' };
		} else {
			const [tilesRes, doneRes] = await Promise.all([
				db().from('vs_tiles').select('id', { count: 'exact', head: true }).eq('event_id', pb.id),
				db()
					.from('vs_submissions')
					.select('id', { count: 'exact', head: true })
					.eq('event_id', pb.id)
					.eq('status', 'approved')
			]);
			personal = { state: 'running', obtained: doneRes.count ?? 0, total: tilesRes.count ?? 0 };
		}
	}

	const rows = events;
	const now = Date.now();
	const signedUpIds = new Set((sus ?? []).map((r) => r.event_id as string));

	const items: EventListItem[] = rows.map((ev) => {
		const startsAt = startsAtFor(ev.slug, ev.starts_at, ev.signup_opens_at);
		const endsAt = endsAtFor(ev.slug, startsAt, ev.ends_at, ev.signup_closes_at);
		const signedUp = signedUpIds.has(ev.id);
		const { section, sortKey, line } = classify(ev, startsAt, endsAt, now, signedUp);
		return {
			id: ev.id,
			slug: ev.slug,
			name: ev.name,
			kind: ev.kind,
			status: ev.status,
			description_preview: markdownPreview(ev.description, 160),
			status_line: line,
			hasSignup: hasSignupFlow(ev),
			signedUp,
			section,
			_sort: sortKey
		};
	});

	const bySection = (s: Section) =>
		items.filter((i) => i.section === s).sort((a, b) => a._sort - b._sort);

	return {
		activeEvents: bySection('active'),
		upcomingEvents: bySection('upcoming'),
		pastEvents: bySection('past'),
		personal
	};
}
