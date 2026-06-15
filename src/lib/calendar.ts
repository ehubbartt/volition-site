// CLIENT-SAFE calendar types + presentation metadata. The home page renders a
// month grid of `CalendarItem`s that come from two sources: admin-authored
// entries in vs_calendar_events (source: 'custom') and milestones derived from
// vs_events dates (source: 'event'). The server builds these in
// src/lib/server/calendar.ts; this module only carries the shapes + colors so it
// can be imported by both the page component and the server loader.

export type CalendarKind = 'signup-open' | 'signup-close' | 'start' | 'end' | 'custom';

export interface CalendarItem {
	id: string;
	title: string;
	date: string; // ISO — when it happens
	endDate: string | null; // ISO — optional end (custom entries only)
	kind: CalendarKind;
	category: string | null; // custom entries only (one of CATEGORY_OPTIONS)
	source: 'event' | 'custom';
	href: string | null; // event page or custom link_url
	description: string | null;
	location: string | null;
	editable: boolean; // true for custom entries — admins get edit/delete
}

// Categories an admin can tag a custom entry with. Each maps to a dot/pill color.
export const CATEGORY_OPTIONS = [
	{ value: 'event', label: 'Event', color: '#ff981f' },
	{ value: 'pvm', label: 'PvM', color: '#ff5d3b' },
	{ value: 'raid', label: 'Raid', color: '#c264ff' },
	{ value: 'social', label: 'Social', color: '#39c0ff' },
	{ value: 'deadline', label: 'Deadline', color: '#ffd23b' },
	{ value: 'other', label: 'Other', color: '#9aa0a6' }
] as const;

export type CalendarCategory = (typeof CATEGORY_OPTIONS)[number]['value'];

const CATEGORY_COLOR: Record<string, string> = Object.fromEntries(
	CATEGORY_OPTIONS.map((c) => [c.value, c.color])
);

// Colors for event-derived milestone kinds.
const KIND_COLOR: Record<CalendarKind, string> = {
	'signup-open': '#0dc10d',
	'signup-close': '#ffd23b',
	start: '#ff981f',
	end: '#9aa0a6',
	custom: '#39c0ff'
};

export function itemColor(item: CalendarItem): string {
	if (item.source === 'custom') {
		return CATEGORY_COLOR[item.category ?? 'event'] ?? KIND_COLOR.custom;
	}
	return KIND_COLOR[item.kind];
}
