# Battleship — ruleset & implementation

A team-vs-team OSRS event where the board game **is** the bingo. Two captains draft the
signup pool into two fleets, each side hides its ships on its own grid, and then the only
way to attack is to play the game: **any drop you get becomes a bomb**, and the bigger the
drop the bigger the hole it makes in the other side's water. First side to sink the enemy
fleet wins.

Sized for **60 players** (30 a side, a 19×19 board) but it scales to whoever actually signs up.

This doc is both the ruleset (numbers are first-pass and meant to be tuned) and the map of
the implementation. See also [`EVENTS.md`](EVENTS.md) for the shared events spine and
[`event-builder-and-dink-tracking.md`](event-builder-and-dink-tracking.md) for the drop
pipeline this hangs off.

---

## Part 1 — Ruleset

### The phases

| Phase | What happens | How it ends |
|---|---|---|
| `signup` | Members join — and may drop back out. | An admin picks two captains and starts the draft. |
| `draft` | Captains **alternate** picks from the pool. | The pool empties — placement opens automatically. |
| `placement` | Each side hides its fleet on its own grid. | The **1-hour** window closes (admin-configurable). |
| `battle` | Drops arm bombs; bombs are fired at the enemy grid. | One side's whole fleet is sunk. |
| `finished` | Standings are final. | — |

The draft is plain alternating ("each captain picks from the pool until everyone is
picked"). With an odd pool the side picking first ends up one player larger.

**Leaving** (`leaveEvent`) is self-serve during `signup` only — including after
`signup_closes_at` has passed, as long as the draft hasn't begun, since someone who knows
they can't make it is better out of the pool than drafted and absent. Once drafted it's
refused: the sides were balanced around who was in the pool, and after placement a
departure would leave a fleet on the board with nobody behind it. The delete is also
scoped `where team_id is null`, so a drafted signup can't be removed whatever the phase
field says. Removing a drafted player is an admin job, not a button.

Placement is on a **deadline**, not a gate: when the window closes the battle opens whether
or not both sides placed. A side that never placed gets a random legal fleet, because a
side with no ships cannot be shot at and would stall the event for everyone else.

### The board scales with the draft

Water per player is fixed (**12 squares**), so the grid grows with the headcount — bombs
arrive in proportion to headcount, so board area has to as well or a big event just
saturates its board:

| Players | Per side | Board | Squares | Ships | Ship squares |
|---|---|---|---|---|---|
| 16 | 8 | **10×10** | 100 | 5 | 17 |
| 32 | 16 | 14×14 | 196 | 10 | 34 |
| 48 | 24 | 17×17 | 289 | 14 | 49 |
| **60** | **30** | **19×19** | **361** | **18** | **63** |
| 100 | 50 | 24×24 | 576 | 29 | 100 |

**A 16-player event is exactly the classic 10×10 board with the classic 5/4/3/3/2 fleet.**
Bigger boards keep the same ~17% ship density by adding more ships, not longer ones.
Bounds are 8×8 and 24×24; an admin can pin an exact size when creating the event.

> **This dial was raised after the 60-player rehearsal.** At 6 squares per player, 60
> players got a 14×14 board and the rehearsal took 185 shots on 196 squares to finish —
> i.e. it ran until the board was nearly all craters, and that was with *random* targeting.
> Real players hunt around their hits, so they'd have got there much sooner. 12 doubles the
> water. It's still a guess against unmeasured drop rates: raise it further if events end
> too quickly.

Ships are placed horizontally or vertically, may **touch** but not overlap (standard rules).

### Drops become bombs

Any **single drop** a member gets during the battle is checked against three tiers. The
value is the stack's value (quantity × unit price), never the summed total of a kill — the
same rule the Discord drop feed already uses, so a herb-run dump of cheap stacks can't add
up to a bomb.

| Tier | Drop value | Bomb | Squares |
|---|---|---|---|
| Cannonball | 5m+ | 1×1 | 1 |
| Bombard | 25m+ | 2×2 | 4 |
| Broadside | 50m+ | 3×3 | 9 |

All three thresholds are set per event when it's created.

> **Why the floor is 5m and not lower.** Members who run Dink against several Discord
> servers are pinned to a `minLootValue` of 3m so the site's tracking doesn't spam their
> other servers. Keeping the smallest bomb above that means they need no config change to
> play. Dropping tier 1 below 3m would silently exclude them.

A bomb goes into the side's **arsenal** and stays there until someone fires it.

**Who can fire what:**

| | Bombs they earned | Teammates' bombs |
|---|---|---|
| A member | ✅ fires them | 👀 sees them, can't fire |
| The captain | ✅ | ✅ |

The captain's blanket permission exists so nothing goes stale when someone logs off for the
night with a Broadside banked. Enforced server-side in `fireBomb`, not by the UI.

The battle page shows this as two sections: **Your bombs** (clickable, the ones you may
fire) and **Team arsenal** (everything the side has banked, with who earned each and a
"yours to fire" tag). Everyone can see the whole side's ammunition — a member who couldn't
would have no idea whether the team was sitting on a Broadside or nothing at all.

### Firing

A bomb is aimed at a square on the enemy grid; its footprint is anchored at the
**top-left** for every tier, so the aiming preview is one rule at every size. The whole
footprint has to land on the board (every square, corners included, is still reachable).

Each covered square is a hit or a miss, exactly like the real game: hits show, misses show,
and a ship is announced as sunk once every one of its squares is hit. Squares that were
already cratered are skipped rather than counted twice — and if *every* square of a bomb
was already hit, the shot is refused and the bomb stays banked instead of being wasted.

**What each side can see:** your own grid in full, the craters on the enemy's grid, and
which of their ships are sunk. Never their ship positions. This is enforced server-side
(see `redactFor` below), not by the UI.

---

## Part 2 — Implementation

### Where things live

- `src/lib/battleship/rules.ts` — pure rules: board sizing, fleet composition, placement
  validation, bomb footprints, hit/sink resolution, standings, draft turn order. No DB and
  no SvelteKit imports, so the server, the pages and the simulation all score a game
  identically. Cells are `"x,y"` strings — the same identity the database's unique index
  uses. Never build one by hand; go through `cellId`/`parseCell`.
- `src/lib/battleship/BoardGrid.svelte` — one grid, used for both boards everywhere, so
  hit/miss rendering can't drift between your water and theirs. Two points worth keeping:
  the labels and the play area are **separate grids sharing one gap**, so the sea is
  exactly the n×n play area and `aspect-ratio: 1` on it keeps cells square at any board
  size (verified square with no horizontal overflow at 1440 / 1024 / 390px); and the cells
  must reset `min-height` and `border-image`, because they are `<button>`s and app.css's
  global bronze frame would otherwise force them 38px tall and rectangular.
- `src/lib/server/battleship.ts` — the store: load a snapshot, and the actions
  (`startDraft`, `draftPick`, `placeFleet`, `startBattle`, `earnBomb`, `fireBomb`).
- `src/lib/server/battleshipPage.ts` — the member payload. Its only job is that everything
  it returns has been through `redactFor`.
- `src/routes/admin/battleship/` — game list + creation; `[slug]/` is the tester.
- `src/routes/events/[slug]/battleship/` — the player page (instant-nav, per
  [`PAGES.md`](PAGES.md)).

> **Routing.** `/events/[slug]` **redirects** a Battleship event here. That generic page is
> the DuoWolf pairing flow — it offers "invite them to duo" — so an event that fell through
> to it would let players form their own duos when sides are supposed to come from the
> captains' draft. `eventsList.ts` also counts Battleship as a signup-flow event so the
> `/events` list shows "Sign up by" rather than treating it as solo. Both are covered by
> `e2e/battleship.spec.ts`.
- `db/scripts/battleship.sql` — schema. Apply with `db/apply.sh --both`.
- `scripts/battleship-sim.mjs` — the end-to-end simulation (`npm run sim:battleship`).

### Data model

The container is a **`vs_events` row** (`kind='battleship'`). `structure.battleship` holds
the phase, the board config (size, tiers, placement window), the draft log and the winner.
Signups and team membership reuse `vs_event_signups` + `vs_teams` like every other event.

Only state that carries a **database-level guarantee** gets a table — the same rule
`gielinor_catan.sql` settled on:

| Table | The guarantee |
|---|---|
| `vs_battleship_teams` | One row per side. `fleet` jsonb rides the row's write atomicity — it's written once, whole, when a side locks placement. |
| `vs_battleship_shots` | One row per **square**, not per bomb. `unique (event_id, target_side, cell)` **is** the "a square can only be fired at once" rule. |
| `vs_battleship_arsenal` | One row per bomb. `unique (event_id, drop_key)` is what makes Dink intake idempotent. |

### Concurrency

An event with 32 people firing at once can't rely on read-then-write, so nothing does:

- **Spending a bomb is a CAS** — `update … where spent_at is null`, then a row-count check.
  A double-submitted fire spends the bomb once.
- **Firing writes one row per square with ON CONFLICT DO NOTHING**, and the rows that
  *actually landed* — not the pre-read — decide what the bomb hit. Two overlapping bombs
  split the squares between them instead of both claiming a hit.
- **Sink and defeat are judged on a re-read** of the target's craters after the write, so a
  concurrent bomb that finished the same ship can't produce two "sunk" announcements.
- **A bomb that wins no squares is handed back** (`spent_at` reset), so losing a race
  doesn't silently eat someone's Tbow.
- **Draft picks CAS the signup row** (`update … where team_id is null`). Two captains
  clicking the same player produce one pick; the loser is told the player just went.

Phase advance is **poll-on-read**: the first page load after the placement deadline opens
the battle. Same pattern as personal-board VP settling — no scheduler to keep alive.

**Bulk drafting is not a loop over `draftPick`.** Each `draftPick` reloads the whole
snapshot (~15 round trips), so draining a 32-player pool one call at a time took over a
minute and timed out the request. `autoDraftRemaining` is one load, one conditional update
per side, and one structure write. It keeps the CAS — the update only claims rows still
`team_id is null`, and only rows it actually claimed enter the draft log — so a captain
picking concurrently can skew the sides by more than one but can never double-assign.

### Redaction

`redactFor(snapshot, viewer)` is the boundary. A viewer gets full ship positions for their
**own** side only; every other side is reduced to its craters (already public) plus a
per-ship `sunk` flag — which is exactly what "you sank my Battleship" reveals.

Admins get both fleets, because the tester has to render them. That's why the browser test
can only assert the page-level half of the contract; the payload-level contract is asserted
as a real non-admin player in the simulation (step 10).

### Dink intake

Every other tracker is item-driven: the proxy records a drop only if the item is in the
active tracked-item allowlist. **No allowlist can express "any drop over 5m,"** so
Battleship needed a second admission rule.

1. `vs_value_tracked_rsns` (in `battleship.sql`) names the members in a live battle and the
   gp floor for each. It only emits players whose event is `open` **and** in the `battle`
   phase, so tracking stops by itself when a game ends — no prune job.
2. The **dink-proxy** loads that view into its manifest and records a loot stack when the
   item is tracked **or** the dropper has a floor and the stack clears it. A missing or
   erroring view degrades to "nobody is value-tracked" rather than throwing, so the bingo
   path is unaffected if this schema hasn't been applied.
3. `processDinkDrops` checks each drop for a bomb **before and independently of** tile
   matching, so one drop can credit a bingo tile, a personal-board tile *and* arm a bomb —
   the same "credit every matching candidate" rule the consumer already follows.

Two rules it inherits from the rest of the pipeline: a drop received **before** the battle
opened arms nothing, and re-running a drop mints nothing further (the reconcile pass
deliberately re-runs recent drops, so this happens routinely). A drop that armed a bomb but
matched no tile is stamped `bomb`, so it doesn't show up in `/admin/dink-drops` under
"Didn't credit".

> **The proxy change has to be deployed** (`npx wrangler deploy` in `dink-proxy`) before
> real drops arm bombs. Until then the site side works but nothing feeds it — you can still
> drive a whole game from the tester, and `earnBomb` can be exercised directly.

### Running a game

1. Apply the schema once: `db/apply.sh --both db/scripts/battleship.sql`.
2. Deploy the proxy so drops are recorded on value.
3. `/admin/battleship` → **New game**. Set the signup window and, if you want, the tier
   thresholds and a fixed board size.
4. Members join at `/events/<slug>/battleship`.
5. When signups close, pick the two captains and **start the draft**. Captains pick from
   the pool (the tester can also auto-draft the rest).
6. The pool emptying opens the **1-hour placement window**; members hide their fleets.
7. The battle opens on its own at the deadline. From there it runs itself: drops arm
   bombs, members fire them, and the event ends when a fleet is gone.

The tester at `/admin/battleship/<slug>` can drive every one of those steps by hand as
either side — including granting bombs — so a whole game can be rehearsed without waiting
on real drops.

### Testing

```bash
npm run sim:battleship                       # full game, 32 players, against staging
npm run sim:battleship -- --players 48 --seed 7 --keep
npx playwright test e2e/battleship.spec.ts   # the same game driven through the UI
```

The simulation runs signup → draft → placement → battle → win through the **real** server
module (loaded via Vite's SSR loader, not reimplemented) and asserts ~60 things about it,
including the two races a live event will actually hit: the same bomb double-submitted, and
overlapping bombs fired at once. It creates an unlisted test event and deletes it again
unless `--keep`.

### Known gaps / next passes

- **Balance is unvalidated against real drop rates.** The thresholds and the 17% density
  are a first pass. A week of 32 players at ~2 big drops each is far more bombs than a
  10×10 board has squares, so the likely outcome is a game that ends in a day or two. If
  that's too fast, raise the tiers or pin a bigger board — both are per-event settings.
- **No Discord announcements yet.** Sinking a ship is a natural thing to post to the drops
  feed; the hook is `fireBomb`'s report.
- **RLS.** The three new tables inherit the repo's current posture (see
  [`PENDING-OPS.md`](PENDING-OPS.md) §1). `enable_rls.sql` loops every public table, so
  re-applying it covers them with no edit.

### Manual claims (members who can't run Dink)

Not everyone runs Dink, and a drop nobody records is a bomb nobody gets. The battle page
carries a **"Not using Dink? Claim a drop manually"** form: the member enters the drop's
value (accepts `5m`, `5,000,000` or `5000000`), optionally names the item, attaches a
screenshot, and submits.

That does **not** arm anything. It files a normal `vs_submissions` row
(`target_id = 'bomb:<value>'`, status `pending`) which shows up in `/admin/submissions`
alongside every other proof, because the value is self-reported and needs a human behind
it. Approving the row calls `mintBombsForApprovedClaims`, which arms a bomb of the tier
matching the claimed value on the claimant's side.

Idempotency is the arsenal's `unique (event_id, drop_key)` again, keyed on the SUBMISSION
id (`manual:<submission id>`) — so revoking and re-approving mints nothing further, and a
concurrent double-approve mints once (the hook only receives the ids the approval actually
flipped).

> The claim's result renders **next to the form**, not at the top of the page. The form
> sits at the bottom of a long page and top-of-page feedback read as "nothing happened".

> **Staging needs the `vs-bingo-proofs` storage bucket.** Prod has it; staging did not,
> which silently broke every proof upload (not just Battleship's) with "Bucket not found".
> Created to match prod: public, no size limit, no MIME restriction.

### The full-event rehearsal

`e2e/battleship-full-event.spec.ts` is the dress rehearsal — a whole 60-player event
driven through the real UI:

```bash
BATTLESHIP_FULL=1 npx playwright test e2e/battleship-full-event.spec.ts
```

It runs at **two viewports** — set `BATTLESHIP_MOBILE=1` for a 390×844 touch phone —
because the board is the risk and a desktop run can't answer "can a person actually place
a ship and aim a bomb at this size". Both runs assert the page never scrolls sideways, the
cells stay square, and (on mobile) that cells clear a 24px tap floor. Screenshots land in
`e2e-shots/desktop/` and `e2e-shots/mobile/`.

> **Phones get a cell-size floor, not smaller cells.** A 19×19 board on a 390px screen
> would give ~12px cells — far under what a thumb can hit, and a mis-tap here *fires a
> bomb at the wrong square with no undo*. Below `--min-cell` (26px) the board scrolls
> **inside its own box** rather than shrinking, with the row numbers pinned so you can
> still say where you hit. The page itself never scrolls sideways.

Skipped unless `BATTLESHIP_FULL=1` so the normal suite stays fast. It seeds 60 players,
signs **two browser contexts in as two different captains** (minting session rows directly
rather than adding an auth surface, since dev-login only signs in the owner), drafts from
both, places both fleets through the placement editor, feeds the battle with Dink payloads
shaped exactly like the proxy writes them plus a manual claim through the review queue,
and fires until a fleet is gone. Screenshots of every stage land in `e2e-shots/`.
