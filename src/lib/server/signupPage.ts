// The member-facing payload for a signup event. Built here so the page can be an
// instant-nav one (docs/PAGES.md): the route has no server load, its universal load fires
// /api/signup/[slug] without awaiting, and navigation lands on a skeleton immediately.
//
// That matters more here than on most pages, because the only way to reach a signup is a
// redirect out of /events/[slug] — a blocking server load would have made it
// nav → fetch → redirect → nav → *wait again*.

import type { SessionUser } from './auth';
import { isAdmin } from './auth';
import { clanMemberIds } from './clan';
import { db, fetchAllFiltered } from './db';
import { loadMySignup, loadSignupEvent, signupWindow, type SignupEventRow } from './signupForm';
import type { SignupAnswers } from '$lib/events/signupForm';

export type SignupPageResult =
	| { kind: 'not_found' }
	| {
			kind: 'ok';
			event: SignupEventRow;
			window: { open: boolean; reason: string | null };
			mine: { id: string; answers: SignupAnswers } | null;
			isAdmin: boolean;
			signedUpCount: number;
			/** Signup order, each name tagged with the clan allegiance test — the page
			 *  splits "Who's in" into Volition and visitors when both are present. */
			names: { rsn: string; volition: boolean }[];
	  };

export async function buildSignupPage(
	user: SessionUser,
	slug: string
): Promise<SignupPageResult> {
	const event = await loadSignupEvent(slug);
	if (!event) return { kind: 'not_found' };

	const admin = isAdmin(user);
	// Draft and preview events are invisible until an admin opens them — the same rule the
	// generic event detail applies.
	if ((event.status === 'draft' || event.status === 'preview') && !admin) {
		return { kind: 'not_found' };
	}

	const [mine, roster] = await Promise.all([
		loadMySignup(event.id, user.id),
		// Names only. This used to call `loadRoster`, which pulls every signup WITH every
		// answer, just to take a count and a list of RSNs — putting the private half of the
		// payload on the member request path for no reason. The answers never left the
		// server, but the safest way to keep it that way is not to fetch them.
		fetchAllFiltered((f, t) =>
			db()
				.from('vs_event_signups')
				.select('vs_users(id, discord_id, rsn)')
				.eq('event_id', event.id)
				.order('joined_at', { ascending: true })
				.range(f, t)
		)
	]);

	// PostgREST types an embedded one-to-one as an array; it is a single row here.
	const rows = ((roster.data ?? []) as unknown as {
		vs_users: { id: string; discord_id: string | null; rsn: string | null } | null;
	}[]);
	const users = rows
		.map((r) => r.vs_users)
		.filter((u): u is { id: string; discord_id: string | null; rsn: string | null } => !!u?.rsn);
	// Which of them are Volition (in the bot's players table) — for a clan-vs-clan
	// signup the page shows the two camps separately. Two reads total, whole roster.
	const volition = await clanMemberIds(users);
	return {
		kind: 'ok',
		event,
		window: signupWindow(event),
		mine,
		isAdmin: admin,
		// The count and the names are public — "42 people are in" is the social proof that
		// makes the next person sign up. The ANSWERS are not: availability is personal, and
		// a public list of who can play least is a way to be picked last in front of everyone.
		signedUpCount: rows.length,
		names: users.map((u) => ({ rsn: u.rsn as string, volition: volition.has(u.id) }))
	};
}
