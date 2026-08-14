-- Signup forms: let an event ask a few questions when someone signs up.
--
-- A "signup event" (vs_events.kind = 'signup') exists before the real event does. It
-- collects a list of people and their answers — "how many hours can you play?" — so an
-- admin can build the actual event later from people who have already said they're in.
--
-- Two halves, and only one of them needs the database:
--   * The QUESTIONS live in vs_events.structure -> 'signupForm'. jsonb, no new column.
--   * The ANSWERS need somewhere to go, and vs_event_signups had nowhere: it is
--     (id, event_id, user_id, team_id, joined_at) and nothing else. Hence this script.
--
-- Safe to re-run; safe to run on a live database. Adding a nullable column takes no
-- table rewrite in Postgres 11+, and every existing signup simply reads as "answered
-- nothing", which is exactly what it did.
--
--   db/apply.sh --both db/scripts/signup_forms.sql
--
-- Shape of `answers`: a flat object keyed by question id, values string or number.
--
--   {"q_1a2b3c4d": 12, "q_5e6f7a8b": "Weekends only"}
--
-- Deliberately NOT keyed by question label — an admin renaming "hours" to "hours per
-- week" would otherwise orphan every answer already given. Ids are minted once, in
-- `newQuestionId`, and never reissued.
--
-- Nothing here constrains the jsonb. Postgres cannot express "matches this event's
-- current question set", and a form whose questions changed after someone answered
-- would fail such a constraint anyway. Validation is in TypeScript at write time
-- (`checkAnswers`) and again at read time (`normalizeAnswers`), because a jsonb column
-- with no constraints is one hand-edited row away from breaking a page.

alter table vs_event_signups
	add column if not exists answers jsonb;

comment on column vs_event_signups.answers is
	'Signup-form answers, keyed by question id (vs_events.structure->signupForm->questions[].id). '
	'Null/absent = this event asked nothing, or they answered nothing. '
	'Unvalidated by the database on purpose — see src/lib/events/signupForm.ts.';

-- The roster page reads every signup for one event and shows the answers inline, so the
-- existing (event_id) index already covers it. No new index: `answers` is never a
-- search key, only a payload.
