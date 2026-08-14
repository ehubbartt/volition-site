// SERVER-ONLY: reads and writes for signup events — the "collect a list and ask a few
// questions before the real event exists" kind.
//
// The interesting call here is `convertRoster`. Everything else is a form; that one is
// the reason the form exists. An admin runs a signup for two weeks, then builds the
// actual event, then pushes the people who answered into it — optionally only the ones
// whose answers clear a bar ("12 hours or more"). Without it the admin retypes 80 names
// and the signup was a survey, not a step in a pipeline.

import { db, fetchAllFiltered } from './db';
import { bustEventCaches } from './microCache';
import {
	SIGNUP_EVENT_KIND,
	checkAnswers,
	newQuestionId,
	normalizeAnswers,
	normalizeForm,
	type SignupAnswers,
	type SignupForm,
	type SignupQuestion
} from '$lib/events/signupForm';

export { SIGNUP_EVENT_KIND };

export type Result<T = undefined> =
	| { ok: true; value?: T }
	| { ok: false; error: string; fieldErrors?: Record<string, string> };

const ok = <T>(value?: T): Result<T> => ({ ok: true, value });
const err = <T>(error: string, fieldErrors?: Record<string, string>): Result<T> => ({
	ok: false,
	error,
	fieldErrors
});

export interface SignupEventRow {
	id: string;
	slug: string;
	name: string;
	description: string | null;
	status: string;
	signupOpensAt: string | null;
	signupClosesAt: string | null;
	form: SignupForm;
}

export interface RosterEntry {
	signupId: string;
	userId: string;
	rsn: string | null;
	discord: string | null;
	joinedAt: string;
	answers: SignupAnswers;
}

// ── Load ────────────────────────────────────────────────────────────────────

function rowToEvent(ev: {
	id: string; slug: string; name: string; description: string | null;
	status: string; signup_opens_at: string | null; signup_closes_at: string | null;
	structure: unknown;
}): SignupEventRow {
	const structure = (ev.structure && typeof ev.structure === 'object' ? ev.structure : {}) as
		Record<string, unknown>;
	return {
		id: ev.id,
		slug: ev.slug,
		name: ev.name,
		description: ev.description,
		status: ev.status,
		signupOpensAt: ev.signup_opens_at,
		signupClosesAt: ev.signup_closes_at,
		form: normalizeForm(structure.signupForm)
	};
}

const SELECT = 'id, slug, name, description, status, signup_opens_at, signup_closes_at, structure';

/**
 * The event, ONLY if it is a signup event.
 *
 * The kind check is load-bearing and belongs here rather than in each route. A `load`
 * guard buys nothing, because a POST never runs `load` — and every action in both routes
 * starts by calling this and bailing on null, so this one line is what stops the member
 * actions from operating on somebody else's event. Without it:
 *
 *   * `?/submit` against any OPEN event inserts a `vs_event_signups` row (no questions →
 *     `checkAnswers` returns ok with `{}`), which walks straight past Battleship's
 *     `phase === 'signup'` gate and past the RSN requirement the generic join enforces;
 *   * `?/withdraw` against a duo or drafted Battleship event deletes a TEAMED signup,
 *     orphaning a team row or pulling a player whose fleet is already on the board.
 *
 * `loadBattleship` guards the same way for the same reason (`ev.kind !== BATTLESHIP_KIND`).
 */
export async function loadSignupEvent(slug: string): Promise<SignupEventRow | null> {
	const { data } = await db()
		.from('vs_events')
		.select(`${SELECT}, kind`)
		.eq('slug', slug)
		.maybeSingle();
	const ev = data as (Parameters<typeof rowToEvent>[0] & { kind: string }) | null;
	if (!ev || ev.kind !== SIGNUP_EVENT_KIND) return null;
	return rowToEvent(ev);
}

/** Every signup for the event, with answers. Admin-facing — includes who each person is. */
export async function loadRoster(eventId: string): Promise<RosterEntry[]> {
	const rows = await fetchAllFiltered((f, t) =>
		db()
			.from('vs_event_signups')
			.select('id, user_id, joined_at, answers, vs_users(rsn, discord_username)')
			.eq('event_id', eventId)
			.order('joined_at', { ascending: true })
			.range(f, t)
	);
	return ((rows.data ?? []) as unknown as {
		id: string; user_id: string; joined_at: string; answers: unknown;
		vs_users: { rsn: string | null; discord_username: string | null } | null;
	}[]).map((r) => ({
		signupId: r.id,
		userId: r.user_id,
		rsn: r.vs_users?.rsn ?? null,
		discord: r.vs_users?.discord_username ?? null,
		joinedAt: r.joined_at,
		answers: normalizeAnswers(r.answers)
	}));
}

/** One person's own signup, or null if they haven't joined. */
export async function loadMySignup(
	eventId: string,
	userId: string
): Promise<{ id: string; answers: SignupAnswers } | null> {
	const { data } = await db()
		.from('vs_event_signups')
		.select('id, answers')
		.eq('event_id', eventId)
		.eq('user_id', userId)
		.maybeSingle();
	const row = data as { id: string; answers: unknown } | null;
	return row ? { id: row.id, answers: normalizeAnswers(row.answers) } : null;
}

// ── Is it open? ─────────────────────────────────────────────────────────────

/**
 * Whether someone may join or edit right now.
 *
 * Unlike the generic `joinEvent`, this honours `signup_opens_at` as well as
 * `signup_closes_at`. That gap is exactly the trap a signup event walks into — you
 * create it a week early with the dates filled in, and on the old path anyone could join
 * the moment the status went `open` because nothing read the opens-at.
 */
export function signupWindow(ev: SignupEventRow, now = Date.now()): {
	open: boolean;
	reason: string | null;
} {
	if (ev.status === 'locked' || ev.status === 'closed') {
		return { open: false, reason: 'Signups have closed' };
	}
	if (ev.status !== 'open') return { open: false, reason: 'Signups are not open yet' };
	if (ev.signupOpensAt && new Date(ev.signupOpensAt).getTime() > now) {
		return { open: false, reason: 'Signups have not opened yet' };
	}
	if (ev.signupClosesAt && new Date(ev.signupClosesAt).getTime() < now) {
		return { open: false, reason: 'Signups have closed' };
	}
	return { open: true, reason: null };
}

// ── Member writes ───────────────────────────────────────────────────────────

/**
 * Join, or update answers if already joined. One entry point on purpose: "sign up" and
 * "change my answer" post the same fields and differ only in whether a row exists.
 */
export async function submitSignup(input: {
	event: SignupEventRow;
	userId: string;
	raw: Record<string, unknown>;
}): Promise<Result<{ created: boolean }>> {
	const { event, userId, raw } = input;

	const existing = await loadMySignup(event.id, userId);
	const window = signupWindow(event);
	if (!window.open) return err(window.reason ?? 'Signups are closed');
	if (existing && !event.form.allowEdits) {
		return err('Your answers are locked in — ask an admin if you need them changed');
	}

	const checked = checkAnswers(event.form, raw);
	if (!checked.ok) return err('Some answers need another look', checked.errors);

	const sb = db();
	if (existing) {
		// MERGE, don't replace. `checkAnswers` only ever returns keys for the CURRENT
		// questions, so a plain replace would delete the answers to any question an admin
		// has since removed — for whoever happens to edit afterwards, and only for them.
		// That would make "deleting a question hides its answers rather than destroying
		// them" true for most people and quietly false for the rest, which is worse than
		// either rule on its own.
		//
		// The cost is that an optional answer cannot be blanked back out once given: a
		// cleared field writes nothing, so the old value survives. Losing an answer nobody
		// can recover is the worse failure of the two.
		const merged = { ...existing.answers, ...checked.answers };
		const { error } = await sb
			.from('vs_event_signups')
			.update({ answers: merged })
			.eq('id', existing.id);
		if (error) return err(error.message);
		bustEventCaches();
		return ok({ created: false });
	}

	const { error } = await sb
		.from('vs_event_signups')
		.insert({ event_id: event.id, user_id: userId, answers: checked.answers });
	// Two tabs, two submits: the unique (event_id, user_id) index catches the second and
	// there is nothing to apologise for — they are signed up either way.
	if (error && !error.message.includes('duplicate')) return err(error.message);
	bustEventCaches();
	return ok({ created: true });
}

/** Withdraw. Self-serve while the window is open; answers go with it. */
export async function withdrawSignup(input: {
	event: SignupEventRow;
	userId: string;
}): Promise<Result> {
	const window = signupWindow(input.event);
	if (!window.open) return err('Signups are closed — ask an admin to remove you');
	// A locked form has to lock this too. Otherwise "your answers are final" is defeated by
	// withdrawing and signing up again with different ones.
	if (!input.event.form.allowEdits) {
		return err('Your answers are locked in — ask an admin if you need to drop out');
	}
	const { error } = await db()
		.from('vs_event_signups')
		.delete()
		.eq('event_id', input.event.id)
		.eq('user_id', input.userId);
	if (error) return err(error.message);
	bustEventCaches();
	return ok();
}

// ── Admin writes ────────────────────────────────────────────────────────────

/**
 * Replace the question set.
 *
 * Ids are preserved for questions that already had one and minted for new ones, which is
 * what keeps existing answers attached across an edit. Deleting a question does NOT
 * delete the answers already given to it — they stay in the jsonb, invisible, and come
 * back if the id ever returns. That is deliberate: an admin who deletes a question by
 * accident during a live signup would otherwise destroy 80 people's answers with one
 * click, and there is no undo for that.
 */
export async function saveForm(input: {
	eventId: string;
	questions: SignupQuestion[];
	intro?: string;
	allowEdits: boolean;
}): Promise<Result<SignupForm>> {
	const withIds = input.questions.map((q) => ({ ...q, id: q.id || newQuestionId() }));
	const form = normalizeForm({
		questions: withIds,
		intro: input.intro,
		allowEdits: input.allowEdits
	});

	const sb = db();
	const { data, error: readErr } = await sb
		.from('vs_events')
		.select('structure')
		.eq('id', input.eventId)
		.maybeSingle();
	if (readErr) return err(readErr.message);

	// Read-modify-write on the jsonb, preserving every other key. Single-writer (one
	// admin on one form), so no CAS — the same posture as the Battleship structure patch.
	const structure = ((data?.structure ?? {}) as Record<string, unknown>) || {};
	const { error } = await sb
		.from('vs_events')
		.update({ structure: { ...structure, signupForm: form } })
		.eq('id', input.eventId);
	if (error) return err(error.message);
	bustEventCaches();
	return ok(form);
}

/** Admin removal — works after the window shuts, unlike `withdrawSignup`. */
export async function removeSignup(input: {
	eventId: string;
	userId: string;
}): Promise<Result> {
	const { error } = await db()
		.from('vs_event_signups')
		.delete()
		.eq('event_id', input.eventId)
		.eq('user_id', input.userId);
	if (error) return err(error.message);
	// The events list caches counts for 15s; without this the removed person keeps being
	// counted. Every other write here busts it — this one was the odd one out.
	bustEventCaches();
	return ok();
}

// ── The handoff ─────────────────────────────────────────────────────────────

export interface ConvertReport {
	targetSlug: string;
	targetName: string;
	added: number;
	alreadyThere: number;
	considered: number;
}

/**
 * Push the people from this signup into another event.
 *
 * This is the whole point of a signup event: the list is not the deliverable, the roster
 * of the REAL event is. Give it the target slug and the user ids to move.
 *
 * Safe to run more than once. `vs_event_signups` has `unique (event_id, user_id)`, so
 * people already in the target are counted and skipped rather than erroring — which
 * matters because the natural way to use this is to convert, realise you missed someone,
 * and convert again.
 *
 * It ADDS. It never removes anyone already in the target, and it never touches the
 * signup event itself — the original list survives the conversion, so a mistake is
 * re-runnable rather than fatal.
 */
export async function convertRoster(input: {
	sourceEventId: string;
	targetSlug: string;
	userIds: string[];
}): Promise<Result<ConvertReport>> {
	const sb = db();
	const slug = input.targetSlug.trim();
	if (!slug) return err('Pick an event to add them to');

	const { data: target } = await sb
		.from('vs_events')
		.select('id, slug, name, kind')
		.eq('slug', slug)
		.maybeSingle();
	const ev = target as { id: string; slug: string; name: string; kind: string } | null;
	if (!ev) return err(`No event with the slug "${slug}"`);
	if (ev.id === input.sourceEventId) return err('That is this signup — pick a different event');
	// Copying a list into another signup form would be harmless but almost certainly a
	// mistake, and the answers would not come with it.
	if (ev.kind === SIGNUP_EVENT_KIND) {
		return err(`"${ev.name}" is another signup form, not an event to seed`);
	}
	// Re-checked here and not only in `convertTargets`, because the slug arrives in a POST
	// and a dropdown is a suggestion once it leaves the browser. A personal board is one
	// member's private bingo; eighty signups landing on it is not recoverable from the UI.
	if (ev.kind === 'personal') {
		return err(`"${ev.name}" is somebody's personal board, not a clan event`);
	}

	const userIds = [...new Set(input.userIds.filter(Boolean))];
	if (userIds.length === 0) return err('Nobody selected');

	const { data: already } = await sb
		.from('vs_event_signups')
		.select('user_id')
		.eq('event_id', ev.id)
		.in('user_id', userIds);
	const have = new Set(((already ?? []) as { user_id: string }[]).map((r) => r.user_id));

	const rows = userIds.filter((id) => !have.has(id)).map((user_id) => ({ event_id: ev.id, user_id }));
	if (rows.length > 0) {
		// Answers deliberately do NOT come along. They were asked in the context of this
		// signup's questions, and the target event has its own (or none) — copying them
		// would key answers to question ids that mean nothing there.
		const { error } = await sb.from('vs_event_signups').insert(rows);
		// One batch, so one racing duplicate would fail the WHOLE insert and add nobody.
		// The unique (event_id, user_id) index is exactly what makes this safe to re-run,
		// so treat its complaint as "somebody got there first", not as a failure.
		if (error && !error.message.includes('duplicate')) return err(error.message);
		bustEventCaches();
	}

	return ok({
		targetSlug: ev.slug,
		targetName: ev.name,
		added: rows.length,
		alreadyThere: have.size,
		considered: userIds.length
	});
}

/**
 * Events a roster can be pushed into.
 *
 * The exclusions matter more than the inclusion. `personal` is one `vs_events` row PER
 * MEMBER — leaving it in meant the fifty newest rows were almost all private bingo boards,
 * crowding real events out of the dropdown entirely and offering an admin the chance to
 * drop eighty people into someone's personal board. `eventsList` excludes `personal` and
 * `unlisted` for exactly this reason; so does this.
 */
export async function convertTargets(
	excludeEventId: string
): Promise<{ slug: string; name: string; kind: string; status: string }[]> {
	const { data } = await db()
		.from('vs_events')
		.select('id, slug, name, kind, status')
		.neq('kind', SIGNUP_EVENT_KIND)
		.neq('kind', 'personal')
		.eq('unlisted', false)
		.order('created_at', { ascending: false })
		.limit(50);
	return ((data ?? []) as { id: string; slug: string; name: string; kind: string; status: string }[])
		.filter((e) => e.id !== excludeEventId)
		.map(({ slug, name, kind, status }) => ({ slug, name, kind, status }));
}
