# Connect Four — ruleset & implementation

A clan-vs-clan event where the board game **is** the bingo. One shared board (sized per
game; **40×15 = 600 tiles** by default); above each column sits a boss drop. The first team to get
that drop claims the column — their piece falls to the lowest empty row, exactly like the real game, and a new
tile drops into the slot above. Connect four in a row to score, and keep going: longer
lines pay more.

Sized for **120 v 120**, but nothing in it depends on the headcount.

This doc is both the ruleset (numbers are first-pass and meant to be tuned) and the map of
the implementation. See also [`EVENTS.md`](EVENTS.md) for the shared events spine and
[`event-builder-and-dink-tracking.md`](event-builder-and-dink-tracking.md) for the drop
pipeline this hangs off.

> **Status: live on prod** (merged 2026-09-08; `connect4.sql` applied to both databases
> 2026-09-09). Games are driven from `/admin/connect4`; members submit claims at
> `/events/[slug]/connect4` and admins approve them in `/admin/submissions`.
> Two follow-ups need `connect4.sql` re-run wherever they are wanted: the
> `vs_connect4_bonus` table (pet bonuses).
>
> **This event runs on manual proof — Dink auto-crediting is deliberately off.**
> See *Tracking* below.

---

## Part 1 — Ruleset

### The phases

| Phase | What happens | How it ends |
|---|---|---|
| `setup` | Curate the pool (one tile per cell), put members on sides. | An admin starts the game, which deals the deck. |
| `live` | Drops claim tiles; pieces fall; lines score. | The board fills, or an admin ends it. |
| `finished` | Standings are final. | An admin may reopen it. |

### The board and the deck

The board's size is **per game**, chosen at creation (5–40 columns × 4–15 rows,
`structure.connect4.size`). cols × rows cells means exactly that many curated tiles —
filling the board consumes the whole deck.

A new game defaults to **40×15 (600 cells)** — `NEW_GAME_SIZE` in
`src/lib/connect4/rules.ts`, and the values the New Game form is pre-filled with. That is
the maximum the clamp allows, and it is what the planned tile list is sized for (244
distinct tiles whose quantities expand to exactly 600 cells — see *Importing a planned
tile list*).

`DEFAULT_SIZE` is a **different** constant and stays at 25×10: games created before the
size was configurable have no stored size, and every read re-derives their geometry from
it. Raising `DEFAULT_SIZE` would silently reinterpret those old boards (wrong deck size,
wrong cell mapping), so new-game defaults move `NEW_GAME_SIZE` only.

The deck is **dealt once, up front**: at start the curated pool is shuffled with a stored
seed, and column `c` owns the slice `[c*rows, c*rows+rows)`. The tile on offer above a
column is therefore `deck[c*rows + piecesInColumn(c)]` — a derivation, not a draw. This is
what makes "a new tile randomly replaces the completed one" work with **no draw-time race
to lose**, and it means the whole board is a pure function of the piece log. Once a column
fills it retires and offers nothing.

Tiles are **shared**: both clans chase the same objectives, one per column. (The design
leaves room for per-team tiles later — the deck lives in `structure`, and every claim
already carries its side.)

Two optional tile shapes on top of the plain single item:

- **Group tiles** (`any_of`) — "Any CoX purple": a drop of ANY listed item claims the
  tile, and the tile's name is just a label. Built from the custom-task form (pick a
  source for its whole priced drop table, and/or type a list); the qualifying list shows
  on the hover card, the detail strip and the CSV. A group tile's icon is its first
  member's. (Each member would also be projected into the Dink allowlist, were
  auto-tracking on — see *Tracking*.)
- **Quantity tiles** (`qty`) — "×3", or "×70,000" for a points tile: one side needs that
  much, and the FIRST side to reach N claims the tile. Per-side progress lives in
  `vs_connect4_progress`, `unique (event_id, drop_key)` exactly like the pieces, so the
  reconcile pass can re-run a counted claim forever and it stays counted once; the claim
  that REACHES N takes the piece with the same drop key. Progress drops are stamped
  `partial` in /admin/dink-drops. Set the ×N in the curation list (a number input on every
  ticked tile) or on the custom-task form.

  **What decides a tile is WHO is claiming, not whether a column was named.** Only an
  explicit admin credit (`adminCredit`, set solely by `creditManual`) claims a ×N tile
  outright — crediting means the tile is decided, not one more drop toward it. This gate
  used to turn on `input.col == null`, i.e. "only the drop pipeline counts", on the
  reasoning that naming a column meant an admin. Manual proof broke that: a member's
  submission names its column too, so it sailed past the gate and **a single screenshot
  finished a thousand-drop tile**. Every non-admin route now banks and waits.

  **A claim banks the AMOUNT it covers**, not one — `vs_connect4_progress.qty`, summed
  rather than counted. `tileQty` capped at 99 back when ×N meant N separate drops; 22
  tiles on this board ask for more (70,000 Mixology points, 6,000 Stardust, 1,500 laps)
  and at that cap a fraction of the work finished the tile. One row per unit is absurd at
  70,000, so one row carries the amount. `qty` is a hand-applied column
  (`db/scripts/connect4.sql`); until it exists the code falls back to one row per claim
  rather than failing the claim, because a pending migration must not stop anyone
  submitting mid-event. PostgREST names a missing column differently on a write
  (`PGRST204`) than on a read (`42703`) — `missingColumn` covers both.

  A partial claim tells the player where they stand ("37 of 100 for your side") rather
  than reporting a bare success.

  **A full rejection gives the bank back.** Progress is written when a claim is SUBMITTED,
  which is what lets submission order decide a contested tile — and it used to mean a
  rejected claim's drops stayed counted forever. A bogus claim for 70,000 points banked
  70,000, and *Reject & free tile* took the piece off but left the bank, so the side's next
  drop of any size tipped the tile over; for a partial-cover claim there is no piece at all,
  so the rejection did nothing whatsoever. `revokeProgressFor` now deletes the row keyed to
  that submission's own `drop_key` before the piece goes, so it takes back exactly what that
  claim put in and no one else's contribution.

  **A claim names the SLOT it is for, not just the column.** A column is a moving target —
  it advances the instant someone claims it — so the loser of a race used to be credited
  whatever the column had moved on to: their review card said *Ancestral hat* and approving
  it confirmed a *Twisted bow* nobody had proved. The member action passes `expectDeckIdx`,
  and `claimTile` returns `raced` on a mismatch, checked on every attempt rather than only
  after a cell conflict — the column can move between the board a player read and the write,
  with no conflict at all. An admin credit passes no slot and still means "whatever this
  column offers now", which is what naming a column intends.

  **Un-approving settles the board; rejecting an approved row is refused.** A revoke flips
  the row straight to `rejected`, so while it did not settle the board the piece stayed
  standing — and the reject a reviewer reached for next matched nothing, because a reject
  only looked at `pending` rows. A mistaken approval was therefore impossible to undo from
  the board at all. Revoke now settles Connect Four rows as a **full** rejection, a reject
  matches `rejected` too (so "Ask again" can be escalated to "Reject & free tile"), and a
  decision that changes no rows returns **409 with a reason** instead of looking like it
  worked. Rejecting an approved row is still not allowed — un-approving is the path,
  because that is what reverses the VP and reclaims the pack.

  **A quantity tile says where the side stands, and who got it there.** The review card
  shows the claiming side's running bank (`Volition 2/3 banked`) beside what the proof
  covers, and flags the claim that actually completed the tile — `target_label` only ever
  said "covers 1 of 3", which reads identically on the first claim and the deciding one.
  The board's hover card lists every contributor to a ×N tile rather than only whoever
  placed the piece; contributor ids ride on `LiveTile.contributors` and each consumer
  resolves them against the roster it already holds, so naming them costs no extra query.
  Both exist because one player's duplicate screenshot completed a tile and nothing on
  either screen made that visible.

  **"credited by hand" means an ADMIN placed it.** A member's approved proof reads *from an
  approved screenshot*. Both use a `manual:` drop key — member claims are
  `manual:submission:<id>` — so a prefix test on `manual:` alone told every player their
  own screenshot had been credited by hand.

  **The offer list sorts three ways, and fresh tiles say so.** *Board order* is the rail's
  own order and the only one that lines up with the tokens above; *Newest first* and
  *Fastest first* answer the two questions players actually ask — what just went up, and
  what can I get quickest. A tile with no EHB, or no known deal time, sorts LAST rather
  than first: an unknown is not a zero. When a tile went up is derived on the client from
  the piece log the payload already carries — a column deals its slice in order, so a tile
  went live when the piece below it landed, and the first slot in a column when the game
  opened. That is the same rule as the reviewer's `tileActiveSince`. Anything dealt within
  15 minutes is flagged **NEW** in red — in the list, and on **both** boards. The flat
  board gives it a row of its own above the rail, on the same column tracks as the tokens
  and the frame, rather than printing it over the art it is pointing at; the row renders
  only while something is actually new. Each cell is its own container so the word is sized
  against the COLUMN rather than the page — "NEW" in a bold sans is about 2.1em wide, so
  46cqw fills the column almost exactly, giving 9.7px on a fitted 40-column board where a
  page-relative size floored out at 6px and was barely visible. The 3D board parents a sprite to the coin, so it
  bobs and falls with it, needs no per-frame projection to stay aligned, and faces the
  camera at any tilt. A tile that arrives through the REQUEUE is not flagged: nothing about
  that swap moves a piece, so there is no timestamp to read.

  **Submitting takes a confirmation step.** Posting a claim is not free: it takes the cell
  immediately, and on a ×N tile it banks immediately, so a proof sent early or sent twice
  costs the side progress only an admin can return. The Submit button therefore opens a
  modal that restates the tile and column, the ×N total and where the side stands, and
  every screenshot about to go — and asks outright whether they have everything needed to
  complete the tile. On a `pre_shot` tile carrying fewer than two images it says so in
  terms, with the tile's own `pre_note`, because the before shot cannot be taken after the
  fact. Cancelling submits nothing; the confirm calls `requestSubmit()` on the real form,
  so `use:enhance` and the staged-file handling are untouched.

  **A submission also confirms itself as a toast.** The line under the claim form sits
  below the fold once the panel is open on a 600-cell board, and a player who misses it
  sends the same screenshot again — which double-banks a ×N tile. The toast is pinned to
  the viewport, says where the side now stands, and tells them not to send it twice.

  `npm run drill:connect4:reject` guards these — it posts the real member
  and admin forms, and reverting any one fix turns its checks red — 7 of 20 for the bank, 5 for the race.

  **Revoking an approval still does not**, and neither does an undo: both leave banked
  progress standing, so the next qualifying claim re-takes the tile. Clear
  `vs_connect4_progress` rows by hand if that was meant to reset the race.

### Scoring

Every dial is per-event and **retunable mid-game**, because standings are recomputed
from the pieces on every read — changing the numbers re-scores the whole board with no
migration and no drift.

| Dial | Default | What it does |
|---|---|---|
| `tile_points` | 10 | Paid per tile claimed. **Set to 0 to score connect-fours only.** |
| `line_points` | 4→40, 5→50, 6→60, 7→70 | What a run of that length pays. |
| `line_mode` | `blocks` | How a run **longer than the table** pays. See below. |
| `extra_per_cell` | 10 | What an ordinary extra cell adds to a line. **Both modes use it.** |
| `pet_points` | 10 | Default for a hand-recorded **pet bonus**. Only pre-fills the award form — see below. |

In one sentence: **every tile is worth 10, and a tile sitting in a line of four is worth
20.** Flatter than the old 100/250/500/900 table on purpose — at 120 v 120 a handful of
contested lines should not outweigh hundreds of ordinary drops.

**A maximal run scores once, at its current length.** A run of six contains three
overlapping windows of four; counting those separately would pay three times for one line.
Only whole runs score, and only from their true start.

**Tiers never stack.** A four that becomes a five stops paying 40 and starts paying 50 — a
net 10 — because nothing is banked incrementally. Undoing that piece puts it back to 40
just as cleanly.

The tester's Scoring form uses `update({ reset: false })` and says *Saved — the board is
re-scored.* With the bare `use:enhance` every box blanked itself on save (see
[FRONTEND.md](FRONTEND.md) — a reset restores the `value` attribute, which Svelte does not
write), and with no confirmation the blanking was the only sign a save had happened at all,
so it looked like saving had wiped the event's numbers. A blank box now means "unchanged"
server-side, so even an empty submit cannot score a whole event at zero.
`e2e/connect4-scoring-form.spec.ts` holds that line.

**Past the table, `line_mode` decides** (`pointsFor` in `rules.ts`):

| Run | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 |
|---|---|---|---|---|---|---|---|---|---|
| `blocks` (default) line pts | 40 | 50 | 60 | 70 | **110** | 120 | 130 | 140 | **180** |
| what that tile was worth | **50** | 20 | 20 | 20 | **50** | 20 | 20 | 20 | **50** |
| `tiers` line pts | 40 | 50 | 60 | 70 | 70 + *extra* | … | | | |

`blocks` means **every fourth tile completes another connect four**. A line never loses
what it had: each cell adds `extra_per_cell` (10), except one that completes a whole
block of four, which adds the 4-tier (40) instead. So the tile that closes a four is
worth 50 — its own 10 plus 40 — and the 8th, 12th and 16th are worth 50 for the same
reason, with the cells between them worth 20.

In one line: **10, 10, 10, 50, 20, 20, 20, 50, 20, 20, 20, 50 …**

A single eight is worth 190 while two separate fours are 160: the 30 difference is the
10 each that the 5th, 6th and 7th cells earned. Extending a line you already hold always
beats starting a new one.

`tiers` is the older rule: the top tier plus `extra_per_cell` for every cell past it, so a
long line keeps growing without bound. **A game stored before this dial existed reads as
`tiers`** — `normalizeScoring` defaults a missing mode to it rather than to the current
default, so re-reading an old board never restates what its sides were already told they
had banked.

That fallback is for **reading** only. A brand-new game has no history to protect, so
`createConnect4` fills any dial the caller omits from `DEFAULT_SCORING` — a fresh board
starts on `blocks`. (It didn't always: creation inherited the read fallback, so new games
quietly scored long runs the `tiers` way. `sim:connect4` now asserts the mode a new game
starts on, and what the 8th tile of a line is worth end to end.)

**Check an existing game before the event starts.** A game created before that fix stored
`tiers`, and it keeps it — the admin scoring panel's *Longer than 7* select shows which
rule a board is on. Switching it re-scores the whole board immediately.

**A cross counts twice.** Two runs meeting at a cell are different directions, and a cross
is genuinely two lines.

`npm run drill:connect4:scoring` asserts this whole table — including that an eight equals
two separate fours, and that a legacy game still scores the `tiers` way. It touches no
database, so it runs anywhere.

#### Bonus awards (pets)

Points that sit **beside** the board rather than on it. Pets are filtered out of the tile
generator on purpose, but a clan landing one during the event should still be worth
something — so an admin records it by hand in the *Pet bonuses* panel and the side's total
goes up. Nothing is dealt, no cell is consumed, the board is untouched.

Two things follow from that, and they are the opposite of how the dials above behave:

* **An award stores the points it was given.** Retuning `pet_points` later changes what the
  form pre-fills, never what a side already banked. Tile and line points are recomputed
  from the piece log on every read; an award is a ledger entry, and restating one after a
  clan has been told its score would be a bug, not a feature.
* **Bonus points decide the winner.** `leaderOf` takes the same per-side totals the
  standings do, so a side ahead on pets wins on pets — at the automatic end-of-board finish
  and at a manual *End the game* alike.

Awards can be given while the game is `live` **or** `finished`, so a pet that lands minutes
before the end can still be honoured after the last piece falls. Removing one is a plain
delete; the standings recompute like everything else.

### Tracking

**Dink auto-tracking is OFF for this event.** `DINK_AUTO_TRACKING` in
`src/lib/server/connect4.ts` is `false`, so a live game projects **nothing** into
`vs_event_tracked_items` and no drop can ever match a tile. The reason is fairness, not
technology: in a clan-vs-clan event only one clan had the plugin set up, which is a head
start rather than a convenience. Flipping that constant back to `true` restores the whole
path — the projection, the proxy allowlist and the drop consumer are all unchanged.

That leaves two ways in, and they are the same code path:

- **Member proof submissions.** A seated member picks the column on the member board,
  uploads a screenshot, and it becomes a generic `vs_submissions` row
  (`target_id = c4:<col>:<deckIdx>`) in the shared `/admin/submissions` queue **and
  places the piece straight away, marked `pending`**. Submission order settles a
  contested tile, which is the point: if the piece only appeared on approval, the tile
  would go to whoever an admin happened to review first.
- **By hand.** An admin credits a column to a side directly from the tester, for anything
  that never became a submission.

#### The evidence gate

A seated member hitting a live board gets the same first-visit acknowledgement modal the
DuoWolf board uses (`$lib/board/BoardAckModal.svelte`), with one extra line specific to
this event: **a drop only counts if it was obtained after the tile went up**, so their
screenshot has to show the in-game clock. That matters more here than on DuoWolf, because
the reviewer's timing check below is only answerable if the player knew to capture it.

Confirmation is remembered in a `voli_c4_ack_<eventId>` cookie. It is a UX nudge, not a
security gate — the server validates every submission regardless.

#### The planned board (the button)

The event runs on one specific designed list, so that list is **checked in**:
`src/lib/server/data/connect4PlannedTiles.json`, 244 tiles expanding to 600 cells.
The pool step's first control is **★ Load the planned board**, which writes it straight
into the game — no export, no upload, and no malformed spreadsheet standing between an
admin and a working board.

Regenerate it when the sheet changes:

```
node scripts/build_planned_tiles.mjs path/to/Tile_Planning-Tiles.csv
```

It parses the export with the *same* parser the CSV import uses, so the button always
loads exactly what importing that file would have produced, and prints the totals to
check against the sheet's own stats block (Low 150 / Medium 300 / High 150 cells).
`npm run drill:connect4:planned` asserts all of that, and that the list still deals onto
a real board.

#### Importing a different tile list

For a list that is *not* the planned one, `/admin/connect4/<slug>` still takes a CSV:
**⭳ Import a different tile list**, in the pool step. One row per tile, and the planning
sheet's own headings are recognised as they are (including its `Inlcluded Items` typo):

| Column | Becomes |
|---|---|
| `Tile` | the tile's name — and, for this event, its whole specification |
| `Source in Game` | the source shown under the name |
| `Quantity Required` | the number needed to finish it |
| `Expected Hours` | the difficulty figure the rail and CSV show |
| `Included Items` | a group tile's qualifying list (comma or slash separated) |
| `Copies` | **how many board cells the tile occupies** |
| `Content Type`, `Tier` | carried for reference |

The reader handles the planning sheet **as exported**, which is not a plain table:

- **Three tier blocks side by side.** Every `Tile` heading starts a block that owns the
  columns up to the next one, so LOW, MEDIUM and HIGH are read from one row each. A
  single-table CSV is simply a file with one block.
- **A repeated header.** A row carrying a `Tile` heading redefines the layout from there
  down, which is what keeps the rows below it aligned.
- **Quoted fields containing newlines.** The sheet's notes column has them, so the file
  is read into records rather than split on `\n` — splitting first tears one record apart
  and every column after it lands in the wrong place.
- **A stats panel in the same columns as the first block.** `Total Low Tiles` and friends
  would import as tiles, so a row is only a tile if it says how many cells it takes; a
  summary row leaves `Copies` blank.
- **Tier from the banner above the block**, not per row — and the *first* banner wins,
  because the sheet's repeated one labels all three blocks "Low".

Every imported row becomes a **custom tile** (a synthetic negative id, matched by name)
because these are hand-written objectives — "Any Barrows Body", "Mixology Points" — not
entries in the generated boss-drop universe. No item allowlist is built, and none is
needed: the event is reviewed by hand, so the NAME is the specification and a human
decides whether the proof meets it.

The import is **all-or-nothing on the cell count**: the copies must total exactly the
board's cells, and a mismatch is refused with the arithmetic spelled out
("fills 600 cells but this board has 250"), because the likely fix is the board size
rather than the plan. It writes the custom list and the pool in a single structure
update — 244 separate calls would be 244 round trips and a half-built board if one
failed.

The planned list for the clan-vs-clan event is 244 distinct tiles expanding to **600
cells, which is exactly a 40×15 board** — the only shape in the allowed range that
divides into 600, and the largest the rules permit.

A problem with the file is reported **inside the import panel**, not only in the page's
error strip at the top: the panel is a fold far down a long page, and a message that
renders only at the top reads as the button having done nothing.

#### Reviewing a claim (the timing check)

A first-come board is only fair if the drop happened **after** the tile went up, and a
screenshot alone can't prove that — someone could submit a drop from last week. So a
Connect Four row in the review queue carries `tileActiveSince`: the moment the piece
beneath it landed (that claim is what dealt this tile in), or the game's `starts_at` for
the first tile in a column. The queue shows it, and approval is gated behind a checkbox
confirming the in-game time in the screenshot is later — the same shape as the WOM
codeword and drop-log checks.

If the column has moved on since (someone else's claim was approved first) the row is
flagged **superseded**: approving it will not place a piece, and the reviewer is told so
before they decide.

#### The two rejections

| Button | The piece | The tile |
|---|---|---|
| **Ask again** (partial) | Stays exactly where it is | Stays theirs — that IS the priority. Nobody can take it while they fetch a better screenshot, and a resubmission re-points the piece they already hold rather than claiming a cell they are standing on. |
| **Reject & free tile** (full) | Deleted, and every piece above it in the column shifts DOWN a row | Goes to the back of `structure.connect4.requeue`; the freed slot takes whatever was at the front. A swap, so the board still holds exactly one tile per cell, and an empty queue is the identity — the tile simply becomes its column's live offer again. |

Shifting a column is only possible because a piece is no longer pinned to the slot whose
number matches its row: it keeps its `deck_idx` — the tile it actually earned — while its
row changes underneath it. That is why `liveTiles` reads "the first UNCLAIMED slot in this
column's slice" rather than indexing by piece count, and why the bounds constraint was
relaxed to `col >= 0 and row >= 0 and deck_idx >= 0`.

**Pending pieces count toward the score.** They occupy their cell, so the standings agree
with the board; the trade is that a full rejection moves the score retroactively. The
waiting-room panel under the member board is what makes that legible — every unreviewed
claim, who holds it, and (for its owner) a partial rejection's note and a prompt to send
another shot.

Verify the whole path with `npm run drill:connect4:review`, which checks the schema is
applied before it starts.

**A member who is signed up but not yet on a side claims nothing.** The side is never
guessed.

### Racing for a shared tile

Both clans can get the same drop within seconds of each other, so first-come-wins is
decided by the **database**, not by comparing timestamps in application code:
`unique (event_id, col, row)` on the pieces table. Both sides compute the same landing
cell, both insert, exactly one lands, and the loser is told it was beaten.

The consumer already drains drops in `received_at` order, which is what makes "first" mean
what it should within a batch. Across batches and processes the index is the only arbiter.

Losing has two shapes, and both are **terminal** — only the first claim for a tile ever
counts, whether it arrived through Dink or an admin's manual credit:

- **Tight** (same drain tick): both inserts race, the index rejects one, and the loser is
  stamped `raced` on the spot.
- **Staggered** (the common one): the loser drains after the winner, by which time the
  claim has removed the item from the allowlist, so the drop matches nothing. `claimTile`
  and the consumer both check `racedOutBy`/`racedOutOf` — "was every copy of this item in
  the deck already claimed, on a live game this player is signed up to?" — and stamp
  `raced` instead of `no_tile`, which the reconcile pass would otherwise re-churn for
  three days. An item that was never dealt, or that still has an unclaimed copy buried in
  a column, stays `no_tile` and can still credit on a later pass.

---

## Part 2 — Implementation

### Where things live

- `src/lib/connect4/rules.ts` — pure rules: gravity, the deck derivation, maximal-run
  detection, scoring. No DB and no SvelteKit imports, so the server, the pages and the
  simulation all score a game identically. Cells are `"col,row"` with **row 0 at the
  bottom**; never build one by hand, use `cellId`/`parseCell`.
- `src/lib/connect4/Connect4Board.svelte` — the flat board. The rail, the column labels and
  the play area are **three grids sharing one column-track definition**, which is what keeps
  a tile card exactly over its column at any width.
- `src/lib/connect4/Connect4Board3D.svelte` — the same board in three.js (see below).
- `src/lib/connect4/playback.svelte.ts` — the playback clock (see below).
- `src/lib/connect4/tokenTexture.ts` — the floating tokens' item art, as cached textures.
- `src/lib/connect4/TileRail.svelte` — the 25 objective cards.
- `src/lib/server/connect4.ts` — the store: load a snapshot, and the actions (`setPool`,
  `enrolMembers`, `assignSides`, `startGame`, `claimTile`, `creditManual`, `undoClaim`,
  `syncTrackedItems`, `finishGame`).
- `src/lib/server/connect4Pool.ts` — the candidate generator (boss drops from
  `itemEhb.json` priced by `bestEhbSource`), the deterministic auto-fill and the
  re-rollable random fill.
- `[slug]/export.csv/+server.ts` — the admin CSV export of the whole tile list.
- `src/routes/admin/connect4/` — game list + creation; `[slug]/` is the tester.
- `src/routes/events/[slug]/connect4/` — the member board (below), fed by
  `src/lib/server/connect4Page.ts` via `/api/connect4/[slug]`.
- `db/scripts/connect4.sql` — schema. **Staging only so far**: `db/apply.sh --staging`.
- `scripts/connect4-sim.mjs` / `scripts/connect4-demo.mjs` — the simulation and the demo.

### Data model

The container is a **`vs_events` row** (`kind='connect4'`). `structure.connect4` holds the
phase, the scoring config, the sides, the curated pool, the dealt deck, the seed and the
winner. Teams reuse `vs_teams` + `vs_event_signups.team_id` like every other event.

**Three tables**, each holding a guarantee the application cannot make for itself:

| Table | The guarantee |
|---|---|
| `vs_connect4_pieces` | `unique (event_id, col, row)` **is** the "first team to the tile claims it" rule. `unique (event_id, drop_key)` **is** what makes intake safe against the reconcile pass. |
| `vs_connect4_progress` | Per-side amount banked toward a QUANTITY tile, keyed to the deck slot. `qty` per row (summed, not counted) so a 70,000-point tile is one row per claim. Same `unique (event_id, drop_key)` guard as the pieces. |
| `vs_connect4_bonus` | Points awarded beside the board (pets). `points` is stored, not derived — see *Bonus awards*. `drop_key` is nullable and unique per event, so hand-entered rows never collide (NULLs don't conflict) while the guard stays available if pet awards are ever automated. |

Everything else — the board, the live tiles, the standings, the winner — is derived from
those rows on every read. There is nothing to keep in sync, which is why `undoClaim` needs
no compensating write.

### The tracked-item projection

Event tiles reach the Dink proxy through **branch 1 of `vs_active_player_tiles`**, which
reads `vs_event_tracked_items × vs_event_signups` — *not* `vs_tiles` (that branch is gated
to `kind='personal'`). So `syncTrackedItems` mirrors the 25 live tiles into
`vs_event_tracked_items` as `tile_id = 'col:<n>'`, `match_type='loot'`. This needs **no
view change and no proxy change**, and only the live tiles are ever tracked.

The projection is **advisory**. A claim always re-derives the live tile from the pieces, so
a stale projection can only mean a drop was recorded needlessly or missed — never that the
wrong tile was credited. It re-syncs on every tester load, so a crash between a claim and
its sync heals itself. No scheduler.

> The event's `status` must be `open` and `starts_at` must have passed for branch 1 to
> emit anything — `startGame` sets both. A game in `setup` tracks nothing by construction.

### Dink intake

`processDinkDrops` routes each candidate by its event's `kind` (`creditCandidate`), so
Connect Four rides the ordinary item-matching path rather than needing a second admission
rule the way Battleship's value tracking does.

**Both loot and collection notifications are accepted.** Battleship has to exclude
`collection` because it mints a bomb *per drop_key*, and a clog unlock sends two
notifications with different keys. Here a claim is idempotent per **tile slot**: the loot
row claims the cell, and the collection twin arrives seconds later to find the column has
moved on.

Two failure modes are worth knowing about, because both were found by the simulation:

- **A re-run drop matches nothing.** Once a tile is claimed its column advances, so the
  item leaves the allowlist entirely. Without a check the drop would be filed as "didn't
  credit" and re-surfaced by every reconcile pass for three days. `pieceForDropKey` closes
  that: a drop that already owns a piece is reported as a duplicate. It is gated behind
  `anyLiveConnect4()`, so with no game running it costs nothing.
- **A concurrent double-submit loses on the CELL index, not the drop-key one.** Postgres
  reports whichever index it checked first, so a cell conflict is not proof of a race —
  `claimTile` asks who owns the drop key before calling it a loss.

`revertDinkCredit` refuses a Connect Four drop and points at the tester, because removing a
piece has rules of its own.

### Watching the board move

**The tester keeps itself fresh** via the live-updates pattern
([`LIVE-UPDATES.md`](LIVE-UPDATES.md)): a 3-second poll of the ~100-byte version token,
with a full board re-load only when the token moves — behind the auto-refresh checkbox,
and never while a replay is running. Dink credits, manual claims, undo and simulated
drops all move the same pieces table, so they all propagate to every open board the same
way. The member page opts in with the same one-liner.

A board that changes while you are not looking should not just *be different* when you come
back. Two things use one mechanism (`playback.svelte.ts`):

- **Catch-up.** Whatever has been claimed since this browser last watched falls into place
  in claim order. The baseline is the **last visit**, kept in localStorage per event — a
  reload is precisely the case being served, so it must not be reset by the page loading.
- **Replay.** A button walks the whole event from an empty board, at 1× to 8×.

Both are "reveal pieces 0..n on a clock", so both are the same class with a different
starting index. The board renders only the first `revealed` pieces and animates whichever
id is `falling`, which is why the flat board and the 3D board need no separate animation
code — they take the same two props.

Three things here are easy to get wrong, and all three were:

- **The effect must not re-run on its own writes.** It banks the ids it has handled; without
  that, the second run finds nothing fresh (the first run having already saved them) and
  cancels the run it just started.
- **The ids are banked when a run ENDS**, not when it starts, so a run cut short by a reload
  plays again rather than being silently skipped.
- **`revealed` starts at `null`, meaning "all"**, because the server renders this component
  with no effects. A numeric default ships HTML with an empty board and flashes it full on
  hydration.

**Crediting is optimistic.** The piece drops the instant you click, derived on the client
(gravity is a pure function of the pieces), and the server's answer replaces it when it
arrives. The round trip is a couple of seconds — long enough that waiting for it made the
board look broken, and made the fall animation appear at random ages after the click.

> The client keeps a **list** of pending pieces, not a single override. An override is the
> obvious shape and it is wrong: click Credit five times quickly and the FIRST response
> clears it, so the four claims still in flight vanish off the board until a reload. The
> board renders `game.pieces` plus every pending piece whose cell the server has not yet
> filled, so a pending piece retires the moment its real one lands and never double-draws.
> Locally-animated cells are also remembered, so the catch-up pass on the next refresh does
> not replay a fall the user already watched.

**The objective above a claimed column** cannot be optimistic in the same way: the deck is
deliberately withheld from the page, so only the server knows what comes next, and shipping
one tile ahead per column would hand both teams a peek at what to pre-farm. So it happens in
two steps instead:

| when | what the column shows |
|---|---|
| the click | `claiming` — the objective dims under a sweep. Claimed; replacement unknown. |
| the claim's own response (~1s) | the real replacement, taken off `ClaimReport.replacement`. |
| the reload behind it (~1s later) | the same thing, from the server's own payload. |

The middle step is the point: `claimTile` already computed the replacement, so returning it
from the action saves the second round trip. Each entry is keyed by the `deckIdx` of the
tile that was claimed and retires itself the moment the server's payload moves that column
past it — so a stale stand-in cannot outlive the truth.

**So is the scoring.** The standings and the run highlight are `$derived` from the merged
board with the same pure functions the server scores with (`standings`, `runCellSet`), not
read out of the page payload. Taking them from the payload meant the four you had just
completed did not light up — and the score did not move — until the round trip landed or
you reloaded, which is precisely the moment the highlight exists for. The server stays the
authority: its pieces replace the pending ones, and the same functions over the same rows
give the same answer.

Hovering anything on the board — a placed piece or a floating objective — raises one card
(`TileHoverCard.svelte`), shared by the flat and 3D views so they can never describe a tile
differently. It names the drop, the boss, the hours to obtain, who claimed it and whether it
came from Dink or by hand, and carries **wiki links** for the item and the boss.

> The card has to survive the pointer leaving the tile to reach those links, and that needs
> a FLAG checked when the hide timer fires — not a cancel. Pointer events are dispatched
> before their compatibility mouse events, so the card's `pointerenter` arrives *before* the
> tile's `mouseleave`: a cancel is simply undone by the schedule that follows it, and the
> card hides exactly as you reach the links.

### The 3D board

A **Flat / 3D** toggle on the play bar, remembered per browser. Both boards take the same
props and are driven by the same clock, so the choice is purely how it looks and they can
never disagree about the state of the game.

`Connect4Board3D.svelte` builds:

- the **frame in front of the discs**, extruded from one `THREE.Shape` with 250 circular
  holes punched in it — that is what makes it read as the board game rather than a grid of
  circles;
- discs as two `InstancedMesh`es, one per side, because 250 individual meshes is a lot of
  draw calls for something a phone may be rendering in software;
- the one piece currently falling as a real mesh, so its animation isn't a matrix rewrite
  every frame; it joins the instances when it lands;
- scoring runs as a pulsing emissive ring;
- the 25 objectives as **floating coins** above the board (below).

Hover **raycasts a single invisible plane** for board cells rather than 250 instances — the
hit maps straight back to a column and row, which is both cheaper and exact. The coins are
raycast directly, since there are only 25 and they need exact hits.

It opens **straight on** — reading 250 cells at an angle is worse than reading them square —
and dragging gives a small parallax tilt. A drag that ends over a coin does not also select
it.

Two things about that tilt, both learned the hard way:

- **The camera fit has to follow the angle.** A fixed straight-on fit is wrong the moment
  you rotate, and the coins sit at the very top of the scene, so they were the first thing
  pushed out of frame — it looked like the board had eaten them. `requiredDistance()`
  projects the scene's corners and pushes the camera back until nothing overflows, which is
  correct at any angle and converges in two or three passes.
- **Rotating must not rebuild the scene.** `init()` reaches `placeCamera()`, which reads
  yaw/pitch, so the mount effect *tracked* them: every drag tore the scene down and rebuilt
  it, and the rebuilt coins start hidden with nothing left to re-show them. The mount effect
  now `untrack`s its body and depends only on the host element.

It reuses the card game's capability probes (`$lib/cards/glCapabilities`): no WebGL says so
and points at the flat board, CPU-rendered WebGL warns that it will be slow, and reduced
motion drops the piece straight in. The GL context, every buffer and the token textures are
disposed on unmount, because toggling back and forth would otherwise leak a context per
mount.

### The floating tokens

In 3D the objectives are **coins in the scene**, one per column, carrying the real item art —
not a strip of flat HTML over a 3D board, which read as two unrelated things stacked on each
other. Clicking one selects its column (the same **Credit** buttons appear below); hovering
one names the item, its boss and what it costs in efficient hours.

The art is a `CanvasTexture` built by `tokenTexture.ts`: the same parchment disc the flat
rail draws, with the item icon composited on top. Two things make that possible at all:

- **The wiki sends `access-control-allow-origin: *`** on the image and on every redirect hop,
  so an `<img>` with `crossOrigin='anonymous'` can be drawn into a canvas without tainting
  it — which is what lets the canvas be a texture. This is the reason the tokens were flat
  HTML in the first pass.
- **It walks the same candidate spellings** as the DOM path (`wikiImageSources`), so the
  case-sensitivity fix carries over.

> A coin is a cylinder, but its **face is a separate `CircleGeometry` child**, not the
> cylinder's cap. Cap UVs are generated in the cylinder's own XZ plane, so the `rotateX` that
> turns a coin to face the camera turns the artwork with it — every item icon lands 90°
> clockwise. A circle mesh parented at `z = depth/2` carries the texture upright.

The texture is returned immediately with the bare disc and the icon appears when it loads —
nothing awaits an image, because a board that waits on 25 round trips before it draws is far
worse than a coin that is briefly blank. Textures are cached by item name, so a replacement
tile reusing an item costs nothing.

**A claimed tile's coin drops into its column and becomes the piece.** The existing `FALL_MS`
window is split rather than extended, so the playback clock is untouched and replay needs no
special case:

| | |
|---|---|
| `0 → 0.35` | the coin falls from the band to the top row, shrinking and turning |
| at `0.35` | the coin is spent; its replacement appears in the band and the coloured disc takes over at the top row |
| `0.35 → 1` | the disc falls to its landing row with the usual bounce |

The handoff is at one x and an adjacent y, so it reads as the coin turning into the piece
rather than two objects swapping.

The coins bob on a per-column phase offset — 25 of them moving in lockstep looks mechanical —
kept well under the 1-unit column spacing so neighbours never intersect. The selected coin
lifts and lights up. Reduced motion holds them still.

> The flat board keeps its HTML rail (`TileRail.svelte`), which is still the right answer
> there — and it is what the 3D coin face is drawn to match, so the two views read as the
> same object.

### Undo

Only the **top piece of a column** can be removed. Taking one from underneath would rewrite
where every piece above it landed, and the board is the record of what happened. The score,
the live tile and the winner all correct themselves, because none of them is stored.

The source is closed too, or the reconcile pass would put the piece straight back: a Dink
drop is stamped `reverted`, an outcome it does not re-surface. It is audit-logged.

### The member board

`/events/[slug]/connect4` is the spectator half: the same board, rail, replay machinery
and hover cards as the tester, with everything that *acts* removed. It follows the
instant-nav pattern ([`PAGES.md`](PAGES.md)) — no server load, a universal load that
fires `/api/connect4/[slug]` behind skeletons — and `/events/[slug]` redirects the
`connect4` kind here, exactly as it does for Battleship.

`src/lib/server/connect4Page.ts` builds the payload, and is where the trust boundary
lives: the snapshot goes through `redactSnapshot` (the undealt deck and the pool never
leave the server — knowing what a column offers next is worth real points) and members
are trimmed to `{userId, rsn}` so the payload doesn't carry every player's Discord id.
The build is also the poll-on-read backstop: a live board drains the drop queue
(`maybeProcessDinkDrops`) before loading, so a member refreshing the page pulls their
own drop through even if the proxy's ping never arrived.

Because nobody credits from this page there is no optimistic state: the server snapshot
is the board, standings and run highlights are recomputed client-side from it, and the
3-second version poll (`liveEvent`, paused mid-replay) keeps it honest. The viewer's own
side, if they are seated, is called out in the header. Sign-in is required (`onboarded`
guard) — the board is clan business, not a public scoreboard.

### Running a game

1. Apply the schema once: `db/apply.sh --staging db/scripts/connect4.sql`.
2. `/admin/connect4` → **New game**. Set the scoring and the side names. Leave **test**
   ticked until it's the real thing — a test game refuses real Dink drops outright, so a
   staged board can never swallow a live drop.
3. **Curate the pool** (one tile per cell). The generator offers boss and raid drops
   only (~340 items in `itemEhb.json`; regenerate with `node db/scripts/build_item_ehb.mjs`
   after game updates — new bosses need a kills/hr entry in its `KILL_RATES`). Clue-casket
   rewards are deliberately excluded: their tables are hundreds of generic cosmetics. A
   250-cell board therefore leans on **copies**, **drops-needed quantities**, group tiles
   and custom tasks for headroom, not on a bigger generated list. The **Generate**
   filter row (stored per game) sets min/max EHB and toggles pets and jars; it shapes
   what the list OFFERS and what the fills draw from, and never
   invalidates already-ticked tiles (saving validates against the unfiltered universe).
   The full filtered list renders with no cap, and the search box matches EVERY boss
   that drops an item, not just the displayed cheapest source — filtering by a boss name
   is its complete drop table (shared drops show a "+N" marker; hover lists the rest).
   *Auto-fill* spreads across the difficulty range deterministically; *Random fill* keeps
   the spread but rolls different tiles every click. When the filtered list offers fewer
   items than the board has cells, both fills switch to `smartSelect`: the shortfall is
   manufactured from ×N-drops variants (a tile needing N drops is priced at N× its EHB,
   and the chooser shows that effective value live, in yellow) and copies (≤20 per item,
   one drops value per item), keeping the effective difficulty evenly spread and never
   past the max-EHB filter. A board bigger than even that can fill fails with a plain
   message instead of a short pool. Every ticked tile gets two labelled
   fields: **drops** (the first side to land that many qualifying drops claims the tile;
   1 = first drop wins) and **copies** (the same tile in N deck slots, each copy its own
   race — extra drops while copies remain stay `no_tile` and can credit later, never
   `raced`). **Custom tasks** — anything the generated list doesn't
   offer — are added by hand above the list: matched by **exact item name** (synthetic
   negative id is UI-only), projected to the allowlist with a null id, listed first. Pick
   several sources in the group builder (ctrl-click) for tiles like "any raids purple" —
   all four raid chests at once.
   **⤓ Export CSV** in the titlebar downloads the whole tile list for a spreadsheet
   overview — the pool during setup, and per-cell status (claimed/on offer/buried, with
   claimant and time) once live.
4. **Put members on sides.** Filter, tick, and send them to a side — one statement for the
   whole batch. This both signs them up and seats them, so it works whether or not they
   have ever touched the event.
5. **Start**, which deals the deck and opens tracking.
6. From there it runs itself. The tester can simulate a drop through the real pipeline,
   credit a column by hand, and undo a piece. Give the players
   `/events/<slug>/connect4` — that's the board they watch.

### Clan vs clan: who is on which side

There is no draft. The sides were decided before anyone signed up — you are on the side
your clan is on — so the roster is a **split, not a pick**.

**The opposing clan signs up on the site like anyone else.** Nothing gates them out: the
signup page (`/events/[slug]/signup`) asks only for a signed-in user with an RSN, Discord
OAuth accepts any Discord account, and `/dink-check` will mint them their own Dink token and
config URL. Their tiles reach the proxy by the same route as ours — branch 1 of
`vs_active_player_tiles` is `vs_event_tracked_items × vs_event_signups`, which knows nothing
about clan membership.

**Allegiance comes from the bot's `players` table**, via `clanMemberIds` in
`src/lib/server/clan.ts`: in it → Volition, not in it → the opposing camp. Discord id first,
then RSN case-insensitively with `_` and ` ` treated as the same character. Deliberately NOT
`vs_users.clan_allegiance`, which is a free choice on the onboarding form and would let
anyone put themselves on either side.

That second camp is labelled with `OPPONENT_LABEL` from `src/lib/clans.ts` (**IronClad**
for this event) everywhere a roster is shown split. Note what it really holds: *everyone
who is not Volition*, since the test is Volition membership rather than IronClad
membership. Right for a two-clan event, and the one line to change when the opponent
does — but a third clan's player would be labelled IronClad too.

`seatByClan` (server) + the **Seat everyone from…** control in the tester's Teams panel do
the split in one go: pick the signup form the roster was collected on, preview, then seat.
Seating also signs everyone up to the game, which is what puts them in the Dink allowlist.

**Hover cards warm up rather than fire instantly.** A 600-cell board means the pointer
crosses dozens of tiles on the way anywhere, so a card waits 350ms before it opens, and
leaving cancels a pending open — a tile merely passed over never pops one. Once a card IS
up, moving along the board swaps it with no wait, so reading the board deliberately never
feels slow. Both boards do this: the flat one in `Connect4Board.svelte`, the 3D one in
`set3dHover` on the page. Hiding still lags 260ms behind the pointer, which is what lets
you reach the wiki links inside the card.


**The rail is also a list.** *Tiles on offer* under the board is the same 40 objectives
as scannable rows — column letter, icon, source, EHB, `×N`, and a **before + after** flag —
with a filter box over item name, source, any-of member and column. Clicking a row runs the
same `selected = col` the rail does, so there is one selection and one claim form, then
scrolls the form into view. It renders only while the game is live and something is on
offer, and the list is capped and scrolled so it cannot push the board off the screen.


**The board zooms by flooring the column width, not by scaling.** A 40-column board fitted
to the page gives each column about 21px, which is too small to read an objective off its
token. The **Fit / Big / Huge** strip beside the Flat/3D toggle sets `cellFloor` (0 / 34 /
48px), which the board applies as `--min-cell`. The rail, the column labels and the frame
are three separate grids sharing one track definition and that same floor, so they widen
*together* and every token stays over its own column; past the container the whole unit
scrolls sideways inside `.wrap` rather than the page doing it. Measured on the 40-column
rehearsal board: rail and frame both 963 / 1480 / 2040px wide at the three settings. The
choice is remembered per browser (`vs_c4_zoom`), and **Fit is the default**, so a player who
never touches it sees the board exactly as before. The initials stand-in on a token sizes
itself in container units for the same reason — on a zoomed board a fixed 28px circle would
stay small while the disc around it grew.

**Side colours are stored, not derived.** `createConnect4` stamps `SIDE_COLORS` — red
`#ef4444` for side 1, yellow `#eab308` for side 2 — into the game's `sides` at creation, and
every renderer reads them back from there: the 2D discs, the 3D discs, the rail, the score
pills, the hover card, the admin credit buttons. Repainting a clan is therefore one write to
`structure.connect4.sides`, safe mid-game (side numbers, teams and pieces are untouched) and
with nothing to redeploy — [`db/scripts/connect4_side_colors.sql`](../db/scripts/connect4_side_colors.sql)
does it by side name. An open board picks the change up on its next load rather than on the
live poll, because the 3D scene bakes one material per side when it is built.

> **Preview before you seat, and read the flagged list.** The rule's failure mode is a real
> Volition member whose site account was never linked to their `players` row — no Discord
> match and an RSN that does not match either — who lands with the visitors. The report
> calls out anyone in that bucket whose own profile says `volition`; on the staging clone
> that is 27 of 104 non-matching accounts. The per-member → *side* buttons fix the rest.

Costs two queries regardless of size: a 135-person roster splits in ~290ms.

**Previewing keeps your choice.** The seat form is `use:enhance` with
`update({ reset: false })`. The default enhance resets a form on success, which threw the
source you had picked away and snapped the select back to *this game's own signups* — so
the obvious "preview, then seat" rhythm seated the wrong list unless you re-picked.

### One event, two rows: the signup form and the board

A clan-vs-clan roster is collected on a **signup form** before the board exists, and the
two are then run as a single event. Seating from a form records it as the game's
`source_event_id`, and from that point:

| | |
|---|---|
| **The board opens when the form says** | `startGame` with no time of its own inherits the form's `starts_at`. Deal the deck the night before; the race still begins when it was announced. |
| **Late signups are visible** | The Teams panel counts anyone on the form who is not yet on the board — *"3 people have signed up since"* — so you can seat from it again right up to the off. |
| **Drift is surfaced, not silent** | Move the form's start after dealing and the panel says so, with one button to move the board to match (`?/syncStart`). It only ever pulls FROM the form: that is the time the clan was told. |

An explicit **Opens at** on the start control beats the inherited time; leave it blank to
take the form's. A game with no form behind it opens the moment it is dealt, as before.

> **A signup form is created with `starts_at` null** — `/admin/events` only asks a signup
> form when it opens and closes, not when the event it is collecting for begins. So there
> is usually nothing to inherit, and the start control says so where it would otherwise be
> read as "it will use the form's time": *"‹form› has no start time set, so leaving this
> blank opens the board as soon as you deal."* Type the announced time into **Opens at**
> and it is exact. Giving signup forms their own start time is the obvious follow-up.

### Tiles that need a BEFORE screenshot

**66 of the 244 planned tiles — 124 of the 600 cells — need a "before" as well as an
after.** They are the ones where an after proves nothing on its own: counters and points
(MTA, Tithe Farm, Pest Control, Mixology), laps and marks (Rooftop, Ape Atoll, Hallowed
Sepulchre), casket loot, and things that may already be sitting in a bank (the Abyssal head
tile says *"precheck on banked unsireds"*). They are highlighted yellow on the **PRECHECKS**
sheet of the planning workbook, and carry `pre` in the checked-in list →
`TileRef.pre_shot` (+ an optional `pre_note`).

It is said in three places, because a player who learns about it at submission time has
already missed their chance to take the shot:

| Where | What they see |
|---|---|
| The token on the rail | The hover title ends *"— NEEDS A BEFORE SCREENSHOT"* (there was a 📷 badge on the token too; it was taken off the live board for being noise at 40 columns) |
| The tile detail line | **📷 before + after** |
| The claim form | A warning **above the drop zone**, with the tile's own note if it has one |
| The review queue | A callout, and a checkbox that **gates the approve button** |

**A game already dealt does not pick this up on its own.** A live board holds its own copy
of every tile, taken at deal time, so editing the planned list does nothing for it. The
admin page has *"Re-apply from the planned list"* (`?/markPreShots` → `applyPreShots`),
which matches by name across the pool, custom list, deck, requeue and assignment overlay
and sets the flag there — **no re-deal, no re-shuffle, nothing moves**. Safe on a board with
pieces on it, and safe to run twice. `npm run drill:connect4:preshot` proves exactly that:
it deals a board without the flag, puts a piece on it, stamps, and asserts the deck order
and the pieces are untouched.

### Sending proof

The claim form takes a screenshot three ways — **paste (Ctrl/Cmd+V), drag & drop, or the
file picker** — and paste is the one that matters: a drop screenshot is already on the
clipboard, and making someone save it to disk first is the slowest possible way to claim a
tile mid-raid. The listener is on the `window` rather than the drop zone, because the claim
form only exists for the tile that is open, so nothing else on the page competes for the
paste and the player does not have to click into the box first. A paste carrying no image
is left alone for whatever else wanted it.

Staged images live in IndexedDB (`$lib/board/draftStore`) keyed by column, so a screenshot
survives closing the tile — take it now, submit when you are done playing. The rest of the
site uses `$lib/ImageDropper` for this; Connect Four has its own because of that draft
store.

`e2e/connect4-player-journey.spec.ts` submits by **dispatching a real paste event**, so the
clipboard path is the one under test rather than the picker.

**Where a send-back lives.** A partial rejection sends the evidence back without taking
the tile away: the piece stays `pending` and holds its cell, and the submission goes to
`rejected`. That drops it out of `/admin/submissions`, which is the queue for claims
waiting on a REVIEWER — these are waiting on a PLAYER. The game's admin page therefore
carries its own **Waiting on a better screenshot** panel, listing every such claim with the
cell, the tile, who holds it, when it was sent back and the note. Without it a send-back
that never came back was invisible to everyone except the person who wrote it.

**What everyone else sees.** The waiting room under the member board is public — both clans
can see what is contested — but the send-back state is not. `needsBetterProof`, the note,
the tile and the resubmit button are all gated on `row.user_id === user.id`, so another
player sees only an ordinary pending claim: the cell, the item, who claimed it and how long
ago. Nobody learns that a rival's evidence was questioned.

**Asked for a better screenshot?** The send-back notice under the board carries a
**Send a better screenshot** button. It has to: by then the column has moved on to its next
tile, so the old instruction — "click column K and send another" — pointed at a different
objective, and the proof would have been filed against it. The button reopens the claim
actually held, and `submitClaim` resolves a `resubmit=1` post through the submitter's own
pending piece (`pendingPieceOf`) rather than through `live[col]`, so the deck slot, the
tile name and any before-screenshot warning are the ones being re-evidenced.

### Tile icons

Icons come from `/api/wiki-image` (see [FRONTEND.md](FRONTEND.md)), never hotlinked — a
600-tile board watched by two clans throttles the wiki otherwise. Three things this board
in particular needed:

- **Sentence case.** The planned list is title-cased, the wiki files items as
  `Bear feet.png`. Adding that spelling took the board from 19 of 244 tiles resolving to
  107.
- **Initials when there is no file.** The other 137 are written as tasks, not items — "Any
  Barrows Helm", "Rooftop Course Laps", "MTA Alchemy Points". Nothing can be fetched for
  those, so `<WikiImage fallback={nameInitials(...)}>` draws the initials instead. The rail
  is what a player reads at a glance and must never be a row of empty discs.
- **No source sub-icon.** The boss's own icon next to "from Araxxor" doubled the wiki
  traffic a board generates for a line of text that already says it. Dropped; the item
  icon is what the budget goes on.

### Listed vs open — two different flags

A game is created **unlisted** so a half-built board is not on display, and `status`
`draft`. Starting it sets `status: 'open'` **and clears `unlisted`** — both are needed:
`/events` filters on `unlisted = false` AND an open-ish status, so an event can be open
and still invisible to the whole clan. That is exactly what happened — nothing ever
cleared the flag a game was created with, so no Connect Four game could reach the events
page. **Test games stay unlisted** when started; they are rehearsals, not events.

The admin page says so at the top when a started game is not listed, with a button either
way (`?/setListing` → `setListed`). The events list is micro-cached for 15s, so both paths
bust it.

### Dealt, but not yet open

`hasOpened(snap)` is the gate: a game is `live` once the deck is dealt, and **open** only
once the clock reaches `startsAt`. In between the board is held shut, and that is enforced
where it counts rather than in the markup:

- `redactSnapshot` blanks the tiles **on offer** for non-admins, not just the undealt deck.
  Hiding them in the template would be worthless — the payload is JSON a member can read,
  and a board dealt the night before would otherwise hand whoever opened devtools a list of
  40 bosses to be standing at. Both clans read the board for the first time at the same
  second.
- `claimTile` refuses with `not_live`, and the member's submit action refuses before it
  reaches the review queue — 240 players sending proof that will only be rejected is a mess
  for everyone.
- The member page shows a countdown that ticks (`$lib/clock.svelte`) and opens itself on
  the stroke, with nobody reloading. The admin gets an `opens …` badge.

Drops timestamped before `startsAt` are rejected as *"That drop predates the game"* even
after the board opens, so nobody can bank a drop in advance.

`npm run drill:connect4:schedule` and `e2e/connect4-scheduled-start.spec.ts` cover all of
it, including the payload leak.

### Who the Teams panel can act on

`rosterFor` (in `connect4.ts`, not the page loader — so it can be drilled without a
browser) answers this, and it has one rule: **anyone on the event is listed, whatever
their site account looks like.**

The list starts as every `vs_users` row that has an RSN, and then adds anyone this game
has on a side or unassigned who that query missed. Without the second half a member seated
with a blank RSN — an opposing-clan player part-way through onboarding, or someone whose
RSN was cleared when they left — was on a side and yet had no row to tick, so
*Remove from event* could not reach them. They render as *(no RSN)* and are removable like
anyone else.

Three things make a member findable in a 300-plus roster:

| | |
|---|---|
| **Filter by RSN** | Matches on the letters alone (`squash`): case, spaces, underscores and hyphens are ignored, so `Some Name` finds `Some_Name`. An RSN is written both ways and an admin types whichever one they are looking at. |
| **On this event only** | Narrows to the people actually enrolled — no typing, and the only way to find someone with no name to type. |
| **Ticks survive filtering** | `picked` is a set of ids, so you can search, tick, search, tick, then act on the lot. |

**Results are reported beside the buttons**, inside the Teams panel: what was removed,
what was seated, and any refusal (`assignError`, kept separate from the page-wide `error`
for exactly this reason). They used to appear only in the banner strip at the top of the
page, hundreds of lines above the roster, so a removal that worked, one that matched
nobody, and one that failed outright were indistinguishable from a dead button.

### Testing

```bash
npm run drill:connect4:roster         # who the Teams panel can act on, incl. no-RSN members
npm run drill:connect4:schedule       # a board seated from a signup form runs to its clock
npm run drill:connect4:preshot        # the 66 before-screenshot tiles, and stamping a live board
npm run sim:connect4                  # the full game, against staging
npm run sim:connect4 -- --quick       # skip filling all 250 cells
npm run sim:connect4 -- --seed 7 --keep
npm run drill:connect4                # every notable path through the REAL Dink consumer:
                                      #   mixed Volition/visitor roster, group + qty +
                                      #   copies tiles, manual credits, race/undo/guards,
                                      #   delete-cleans-everything — 49 checks, self-cleaning
npm run demo:connect4                 # leaves a playable board behind
npm run demo:connect4 -- --phase setup --slug c4-setup-demo
npm run demo:connect4 -- --delete
```

The simulation drives create → curate → assign → start → claims → board full through the
**real** server module (loaded via Vite's SSR loader, not reimplemented) and asserts ~90
things about it, including the races a live event will actually hit: two teams claiming the
same shared tile at once, the same drop double-submitted, a drop re-run by the reconcile
pass, and a collection-log twin. It creates an unlisted test event and deletes it again
unless `--keep`.

Like the Battleship demo, it fills the roster with **real members as stand-ins** rather
than inventing `vs_users` rows, which would land in the member counts and rank tables the
home page builds from that table. Safe on staging, which takes no live Dink traffic. Don't
point it at a database that does.

#### Rehearsing with manufactured Dink drops

The proxy repo's `scripts/send-test-drop.mjs` posts a fake Dink LOOT payload through the
REAL worker code, in-process, at whatever Supabase the shell points at — and with
`SITE_URL` + `DINK_PROCESS_SECRET` in the shell it fires the real drain ping, so the whole
pipeline (insert → ping → credit → the board's 3s version poll) runs with nothing deployed.
Aim it at the item/source of a live objective for an RSN seated on a side. Two traps:

- **Test games refuse real-shaped drop keys by design** (`dropKeyAllowed`), so a proxy
  rehearsal needs a game created with the "Test game" box **unticked**. To delete it after,
  flip `structure.connect4.test` to true in the DB first.
- The deployed prod worker writes to the **prod** DB — a real Dink client only reaches
  staging through `dink-proxy-staging` (`npx wrangler deploy --env staging`).

#### The UX pass

`e2e/connect4-event.spec.ts` runs with `npm run test:e2e` and drives the whole event
through the **real admin UI** in a browser — create, auto-fill the deck, seat both sides,
deal, hover an objective, credit by hand, race five clicks at one column, build a run and
extend it, send a drop through the Dink pipeline, undo, replay, switch to the 3D board and
back, play at 390px, finish, reopen and delete. Where the simulation asserts the rules, this
asserts that a person can DO all of it: that a credited piece is on screen in ~100ms rather
than waiting on the ~4s round trip, that the drop animation actually plays, that nothing
scrolls sideways on a phone, and that the page never throws. Screenshots land in
`e2e-shots/connect4/`, and it deletes its own test game — plus any left behind by a run
that died half-way.

### Known gaps / next passes

- **Staging is admin-only** (`STAGING_ADMIN_ONLY`), so the visiting clan cannot see anything
  there. Their signups and the live game have to be on production, which means this branch
  has to reach `main` and `db/scripts/connect4.sql` has to be applied to the production
  database first.
- **A wrong RSN is a silent no-op.** Drops are matched to a site account by RSN, so a
  visitor who typos theirs will play a whole event that scores nothing. Worth a pass over
  the roster's RSNs before the start.
- **The member page is watch-only.** There is no manual claim path for a player whose
  Dink is not set up — an admin credits those by hand from the tester. If that becomes a
  bottleneck, Battleship's claim-with-screenshot queue is the pattern to borrow.
- **Balance is unvalidated.** The scoring defaults are a first pass against unmeasured drop
  rates. All three dials are per-event and retunable mid-game.
- **No Discord announcements.** Completing a connect four is the natural hook, in
  `claimTile`'s report.
- **The 3D board's board area is read-only.** Clicking a floating coin selects its column and
  the Credit buttons appear below, but the cells themselves take no clicks.
- **The pool is boss drops only**, and the same 25 tiles serve both clans.
- **RLS.** The new table inherits the repo's current posture (see
  [`PENDING-OPS.md`](PENDING-OPS.md) §1). `enable_rls.sql` loops every public table, so
  re-applying it covers it with no edit.
