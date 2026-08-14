# Signup forms

A **signup event** (`vs_events.kind = 'signup'`) exists before the real event does. It
collects a list of people and their answers to a few questions — "how many hours a week
can you play?" — so an admin can size and build the actual event from people who have
already said they're in.

It is deliberately not a game. No teams, no board, no tasks, no structure beyond the
questions. The deliverable is the roster, and the roster's destination is another event.

**Any admin can run one end to end.** Every route here checks `isAdmin` and nothing more,
and `isAdmin` is satisfied by a `vs_admin_roles` grant made at `/admin/admins` — no env
edit, no redeploy, no owner involvement.

---

## The loop

```
/admin/events              create → kind "Signup form"
        ↓
/admin/events/[slug]/signup   write the questions
        ↓
/events/[slug]/signup      members answer; they can change answers while it's open
        ↓
/admin/events/[slug]/signup   read the answers, copy the CSV
        ↓                     …build the real event, then:
   "Use these people"      → their signups appear on the target event
```

The last arrow is the point. Without it the signup is a survey and someone retypes eighty
names into whatever gets built.

---

## Where things live

| | |
|---|---|
| Questions | `vs_events.structure.signupForm` — jsonb, no new column |
| Answers | `vs_event_signups.answers` — jsonb, added by `db/scripts/signup_forms.sql` |
| Types, validation, CSV | `src/lib/events/signupForm.ts` (client-safe, no DB) |
| Reads/writes, the handoff | `src/lib/server/signupForm.ts` |
| Member payload | `src/lib/server/signupPage.ts` → `/api/signup/[slug]` |
| Member page | `src/routes/events/[slug]/signup/` (instant-nav: no server load) |
| Admin builder + roster | `src/routes/admin/events/[slug]/signup/` |

The member page follows the instant-nav pattern in [`PAGES.md`](PAGES.md) rather than a
server load, and it matters more here than usual: the only way to reach it is a redirect
out of `/events/[slug]`, so a blocking load would have meant nav → fetch → redirect → nav →
*wait again*. The admin page keeps a classic load, which `PAGES.md` explicitly allows for
per-event pages.

The member payload carries the **count and the names only** — it never fetches anyone's
answers, so the private half cannot leak through a page that has no business holding it.

**Answers are keyed by question id, never by label.** An admin renaming "hours" to "hours
per week" would otherwise orphan every answer already given. Ids are minted once by
`newQuestionId` and never reissued — which is also why the editor posts blank ids for new
questions and lets the server fill them in.

**Nothing about either jsonb is enforced by the database.** Postgres cannot express
"matches this event's current question set", and a form whose questions changed after
someone answered would fail such a constraint anyway. Validation is `checkAnswers` on the
way in and `normalizeForm`/`normalizeAnswers` on the way out — an unvalidated jsonb column
is one hand-edited row away from breaking a page, so everything that reads it assumes the
worst.

---

## Things that bit, and how they're handled

**`signup_opens_at` is not enforced anywhere else.** The generic `joinEvent` checks only
`status` and `signup_closes_at`, so an event created a week early with the dates filled in
is joinable the moment its status goes `open`. `signupWindow` here honours both ends, so a
signup form behaves the way its own dates say it does.

**A signup must never render on `/events/[slug]`.** That page is the DuoWolf pairing flow
— it offers "invite them to duo" and a "View board →" link to a board that doesn't exist.
`eventDetail` redirects the kind to `/events/[slug]/signup`, exactly as Battleship does.

**Deleting a question does not delete its answers.** They stay in the jsonb, invisible,
and reappear if the id ever returns. An admin who deletes a question by accident during a
live signup would otherwise destroy eighty people's answers with one click, and there is
no undo for that.

> This is why `submitSignup` **merges** rather than replaces. `checkAnswers` only returns
> keys for the questions that currently exist, so a plain column replace would have kept
> the hidden answers for everyone who never touched the form again and destroyed them for
> anyone who edited afterwards — the promise above true for most people and quietly false
> for the rest. The cost of merging is that an optional answer cannot be blanked back out
> once given; losing an answer nobody can recover is the worse of the two.

**`loadSignupEvent` refuses any event that is not a signup**, and that one line is what
makes the member actions safe. A `load` guard buys nothing, because a POST never runs a
`load` — without the check, `?/submit` against any *open* event would insert a signup row
(no questions → no required answers), walking past Battleship's `phase === 'signup'` gate
and past the RSN requirement the generic join enforces; and `?/withdraw` would delete a
**teamed** signup, orphaning a team row or pulling a drafted player whose fleet is already
on the board. `loadBattleship` guards on `kind` for the same reason.

**A locked form (`allowEdits: false`) locks withdrawal too.** Otherwise "your answers are
final" is one withdraw-and-rejoin away from meaningless.

**The builder refuses a non-signup event.** Pointed at a bingo it would happily render the
roster and then write a `signupForm` key into that bingo's structure, where nothing reads
it and the bingo normalizer strips it on the next builder save — the admin's work quietly
gone. It 400s instead.

**Answers are not public.** The member page shows the count and the names, because "42
people are in" is what makes the next person sign up. It does not show anyone else's
answers: availability is personal, and a public list of who can play least is a way to be
picked last in front of everyone.

---

## The handoff

`convertRoster` copies the selected people into the target event's `vs_event_signups`.

- It **adds**. It never removes anyone already in the target, and never touches the signup
  event — so a mistake is re-runnable rather than fatal.
- It is **idempotent**: `unique (event_id, user_id)` means people already there are counted
  and skipped, not errors. The natural second use is "convert, spot a straggler, convert
  again".
- **Answers do not travel.** They were given against this form's question ids, which mean
  nothing on the target event.
- The target may not be another signup form — that would be a copy with the answers left
  behind, almost certainly a mistake.
- **Nor a personal bingo board.** `personal` is one `vs_events` row *per member*; leaving
  it in the target list meant the fifty newest rows were nearly all private boards, real
  events were crowded out of the dropdown entirely, and an admin could drop eighty people
  into someone's personal board. Excluded from the list and refused again in
  `convertRoster`, because a dropdown is only a suggestion once it leaves the browser.

For anything the handoff can't express — seeding two sides from one list, arguing about
who gets whom — use **Copy as CSV**. One row per person, one column per question.

---

## Running one

1. `/admin/events` → **Create event** → type **Signup form**. Give it a slug, a name, and
   a close date. Status `open` makes it live immediately; `draft`/`preview` keeps it
   admin-only until you're ready.
2. **Questions & roster →** on that event's card. Add questions, hit save. You can keep
   editing after people have answered.
3. Share `/events/<slug>/signup`.
4. When you're ready, build the real event, come back, select who you want, and send them
   over.

Question types are short text, paragraph, number (with optional min/max), and pick-one.
Twelve questions max, twelve options per pick-one — a signup nobody finishes is worse than
one that asked less.
