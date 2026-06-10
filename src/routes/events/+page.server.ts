import { redirect } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { isAdmin } from '$lib/server/auth';
import { markdownPreview } from '$lib/markdown';
import {
	BINGO_EVENT_SLUG,
	BINGO_ROW_COUNT,
	BINGO_ROW_INTERVAL_HOURS
} from '$lib/bingo/config';
import type { PageServerLoad } from './$types';

const HOUR_MS = 3_600_000;
const BINGO_DURATION_MS = BINGO_ROW_COUNT * BINGO_ROW_INTERVAL_HOURS * HOUR_MS;

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

function pickStatusLine(
	now: number,
	opens: string | null,
	closes: string | null,
	starts: string | null,
	ends: string | null
): { label: string; date: string } | null {
	const candidates: Array<{ label: string; date: string }> = [];
	if (opens) candidates.push({ label: 'Signups open', date: opens });
	if (closes) candidates.push({ label: 'Signups close', date: closes });
	if (starts) candidates.push({ label: 'Starts', date: starts });
	if (ends) candidates.push({ label: 'Ends', date: ends });

	const future = candidates
		.map((c) => ({ ...c, t: new Date(c.date).getTime() }))
		.filter((c) => c.t > now)
		.sort((a, b) => a.t - b.t);
	if (future.length > 0) return { label: future[0].label, date: future[0].date };

	if (ends) return { label: 'Ended', date: ends };
	return null;
}

function sortKey(
	now: number,
	opens: string | null,
	closes: string | null,
	starts: string | null,
	ends: string | null
): number {
	const all = [opens, closes, starts, ends]
		.filter((s): s is string => Boolean(s))
		.map((s) => new Date(s).getTime());
	const future = all.filter((t) => t > now);
	if (future.length > 0) return Math.min(...future);
	if (all.length > 0) return Math.max(...all) + 1e13;
	return Number.MAX_SAFE_INTEGER;
}

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) throw redirect(303, '/');
	if (!locals.user.rsn || !locals.user.clan_allegiance || !locals.user.account_type) {
		throw redirect(303, '/onboarding');
	}

	const admin = isAdmin(locals.user);
	const visibleStatuses = admin
		? ['draft', 'preview', 'open', 'locked', 'closed']
		: ['open', 'locked', 'closed'];

	// Tasks live in vs_tasks (their own table / the To Do page), so vs_events is
	// only "full events" here — no task filtering needed.
	const { data: events, error } = await db()
		.from('vs_events')
		.select(
			'id, slug, name, description, status, signup_opens_at, signup_closes_at, starts_at, ends_at'
		)
		.in('status', visibleStatuses);

	if (error) throw new Error(error.message);

	const now = Date.now();

	const items = (events ?? []).map((ev) => {
		const startsAt = startsAtFor(ev.slug, ev.starts_at, ev.signup_opens_at);
		const endsAt = endsAtFor(ev.slug, startsAt, ev.ends_at, ev.signup_closes_at);
		const allDates = [ev.signup_opens_at, ev.signup_closes_at, startsAt, endsAt]
			.filter((s): s is string => Boolean(s))
			.map((s) => new Date(s).getTime());
		return {
			...ev,
			description_preview: markdownPreview(ev.description, 160),
			resolved_starts_at: startsAt,
			resolved_ends_at: endsAt,
			status_line: pickStatusLine(
				now,
				ev.signup_opens_at,
				ev.signup_closes_at,
				startsAt,
				endsAt
			),
			_sort_key: sortKey(now, ev.signup_opens_at, ev.signup_closes_at, startsAt, endsAt),
			_recent_key: allDates.length > 0 ? Math.max(...allDates) : 0
		};
	});

	const active = items
		.filter((ev) => ev.status !== 'closed')
		.sort((a, b) => a._sort_key - b._sort_key);
	const past = items
		.filter((ev) => ev.status === 'closed')
		.sort((a, b) => b._recent_key - a._recent_key);

	return { events: active, pastEvents: past };
};
