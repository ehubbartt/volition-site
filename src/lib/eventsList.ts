// CLIENT-SAFE types for the /events list page. The data itself is built server-side
// in $lib/server/eventsList.ts and served as JSON by /api/events-list, so the page's
// universal load (zero-round-trip navigation) can type its streamed fetch.

export type Section = 'active' | 'upcoming' | 'past';

export interface ActionLine {
	label: string;
	date: string | null;
}

export interface EventListItem {
	id: string;
	slug: string;
	name: string;
	kind: string;
	status: string;
	description_preview: string | null;
	status_line: ActionLine | null;
	hasSignup: boolean;
	signedUp: boolean;
	section: Section;
	_sort: number;
}

// State for the always-present "Personal Bingo" card at the top of the list —
// the entry point for creating (or getting back to) your own board.
export type PersonalCard =
	| { state: 'none' }
	| { state: 'draft' }
	| { state: 'running'; obtained: number; total: number };

export interface EventSections {
	activeEvents: EventListItem[];
	upcomingEvents: EventListItem[];
	pastEvents: EventListItem[];
	personal: PersonalCard;
}
