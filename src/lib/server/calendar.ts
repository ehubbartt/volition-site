import { db } from './db';
import {
	BINGO_EVENT_SLUG,
	BINGO_ROW_COUNT,
	BINGO_ROW_INTERVAL_HOURS
} from '$lib/bingo/config';
import type { CalendarItem } from '$lib/calendar';

// SERVER-ONLY calendar assembly. Merges admin-authored vs_calendar_events rows
// with milestones derived from vs_events dates into a single flat CalendarItem[]
// for the home page. Mirrors the event date/visibility logic used by /events.

const HOUR_MS = 3_600_000;
const BINGO_DURATION_MS = BINGO_ROW_COUNT * BINGO_ROW_INTERVAL_HOURS * HOUR_MS;

interface CalendarEntryRow {
	id: string;
	title: string;
	description: string | null;
	starts_at: string;
	ends_at: string | null;
	location: string | null;
	link_url: string | null;
	category: string | null;
}

interface EventRow {
	id: string;
	slug: string;
	name: string;
	status: string;
	signup_opens_at: string | null;
	signup_closes_at: string | null;
	starts_at: string | null;
	ends_at: string | null;
}

function eventHref(slug: string): string {
	return slug === BINGO_EVENT_SLUG ? `/bingo/${slug}` : `/events/${slug}`;
}

// The bingo event has no explicit starts_at/ends_at — it begins at signup_opens_at
// and runs for the full row-release window (mirrors /events).
function resolveStart(ev: EventRow): string | null {
	return ev.starts_at ?? (ev.slug === BINGO_EVENT_SLUG ? ev.signup_opens_at : null);
}

function resolveEnd(ev: EventRow, startsAt: string | null): string | null {
	if (ev.ends_at) return ev.ends_at;
	if (ev.slug === BINGO_EVENT_SLUG && startsAt) {
		return new Date(new Date(startsAt).getTime() + BINGO_DURATION_MS).toISOString();
	}
	return null;
}

export async function loadCalendarItems(admin: boolean): Promise<CalendarItem[]> {
	const sb = db();
	const visibleStatuses = admin
		? ['draft', 'preview', 'open', 'locked', 'closed']
		: ['open', 'locked', 'closed'];

	const [entriesRes, eventsRes] = await Promise.all([
		sb
			.from('vs_calendar_events')
			.select('id, title, description, starts_at, ends_at, location, link_url, category')
			.order('starts_at', { ascending: true }),
		sb
			.from('vs_events')
			.select('id, slug, name, status, signup_opens_at, signup_closes_at, starts_at, ends_at')
			.in('status', visibleStatuses)
			.neq('slug', 'dink-self-test')
	]);

	const items: CalendarItem[] = [];

	for (const e of (entriesRes.data ?? []) as CalendarEntryRow[]) {
		items.push({
			id: e.id,
			title: e.title,
			date: e.starts_at,
			endDate: e.ends_at,
			kind: 'custom',
			category: e.category ?? 'event',
			source: 'custom',
			href: e.link_url || null,
			description: e.description,
			location: e.location,
			editable: true
		});
	}

	for (const ev of (eventsRes.data ?? []) as EventRow[]) {
		const href = eventHref(ev.slug);
		const startsAt = resolveStart(ev);
		const endsAt = resolveEnd(ev, startsAt);
		const isBingo = ev.slug === BINGO_EVENT_SLUG;

		const push = (
			kind: CalendarItem['kind'],
			date: string | null,
			suffix: string
		) => {
			if (!date) return;
			items.push({
				id: `evt-${ev.id}-${kind}`,
				title: `${ev.name} · ${suffix}`,
				date,
				endDate: null,
				kind,
				category: null,
				source: 'event',
				href,
				description: null,
				location: null,
				editable: false
			});
		};

		// Bingo isn't signup-based — only show its start/end.
		if (!isBingo) {
			push('signup-open', ev.signup_opens_at, 'signups open');
			push('signup-close', ev.signup_closes_at, 'signups close');
		}
		push('start', startsAt, 'starts');
		push('end', endsAt, 'ends');
	}

	items.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
	return items;
}
