# Connect Four — ruleset & implementation

A clan-vs-clan event where the board game **is** the bingo. One shared **25×10** board;
above each of the 25 columns sits a boss drop. The first team to get that drop claims the
column — their piece falls to the lowest empty row, exactly like the real game, and a new
tile drops into the slot above. Connect four in a row to score, and keep going: longer
lines pay more.

Sized for **120 v 120**, but nothing in it depends on the headcount.

This doc is both the ruleset (numbers are first-pass and meant to be tuned) and the map of
the implementation. See also [`EVENTS.md`](EVENTS.md) for the shared events spine and
[`event-builder-and-dink-tracking.md`](event-builder-and-dink-tracking.md) for the drop
pipeline this hangs off.

> **Status: admin-only, staging-only.** There is no member-facing page yet, and the schema
> is applied to staging alone. Everything below is driven from `/admin/connect4`.

---

## Part 1 — Ruleset

### The phases

| Phase | What happens | How it ends |
|---|---|---|
| `setup` | Curate the 250 tiles, put members on sides. | An admin starts the game, which deals the deck. |
| `live` | Drops claim tiles; pieces fall; lines score. | The board fills, or an admin ends it. |
| `finished` | Standings are final. | An admin may reopen it. |

### The board and the deck

25 columns × 10 rows = **250 cells, and exactly 250 curated tiles**. Filling the board
consumes the whole deck.

The deck is **dealt once, up front**: at start the curated pool is shuffled with a stored
seed, and column `c` owns the slice `[c*10, c*10+10)`. The tile on offer above a column is
therefore `deck[c*10 + piecesInColumn(c)]` — a derivation, not a draw. This is what makes
"a new tile randomly replaces the completed one" work with **no draw-time race to lose**,
and it means the whole board is a pure function of the piece log. After ten pieces a
column retires and offers nothing.

Tiles are **shared**: both clans chase the same 25. (The design leaves room for per-team
tiles later — the deck lives in `structure`, and every claim already carries its side.)

### Scoring

All three dials are per-event and **retunable mid-game**, because standings are recomputed
from the pieces on every read — changing the numbers re-scores the whole board with no
migration and no drift.

| Dial | Default | What it does |
|---|---|---|
| `tile_points` | 10 | Paid per tile claimed. **Set to 0 to score connect-fours only.** |
| `line_points` | 4→100, 5→250, 6→500, 7→900 | What a run of that length pays. |
| `extra_per_cell` | 400 | Paid per cell beyond the longest configured run. |

**A maximal run scores once, at its current length.** A run of six contains three
overlapping windows of four; counting those separately would pay three times for one line.
Only whole runs score, and only from their true start.

**Extending a line pays the difference.** A four that becomes a five stops paying 100 and
starts paying 250 — a net 150 — because nothing is banked incrementally. Undoing that piece
puts it back to 100 just as cleanly.

**A cross counts twice.** Two runs meeting at a cell are different directions, and a cross
is genuinely two lines.

### Tracking

Two ways in, and they are the same code path:

- **Dink.** The 25 live tiles are projected into `vs_event_tracked_items`, which is what
  feeds the proxy's allowlist and the drop consumer's matcher. A member's drop claims the
  tile above whichever column is offering it, **for their own side**.
- **By hand.** An admin credits a column to a side from the tester. Used for anything Dink
  can't see — and it is the fallback for the opposing clan while they are still onboarding.

**A member who is signed up but not yet on a side claims nothing.** The side is never
guessed.

### Racing for a shared tile

Both clans can get the same drop within seconds of each other, so first-come-wins is
decided by the **database**, not by comparing timestamps in application code:
`unique (event_id, col, row)` on the pieces table. Both sides compute the same landing
cell, both insert, exactly one lands, and the loser is told it was beaten.

The consumer already drains drops in `received_at` order, which is what makes "first" mean
what it should within a batch. Across batches and processes the index is the only arbiter.

---

## Part 2 — Implementation

### Where things live

- `src/lib/connect4/rules.ts` — pure rules: gravity, the deck derivation, maximal-run
  detection, scoring. No DB and no SvelteKit imports, so the server, the pages and the
  simulation all score a game identically. Cells are `"col,row"` with **row 0 at the
  bottom**; never build one by hand, use `cellId`/`parseCell`.
- `src/lib/connect4/Connect4Board.svelte` — the board. The rail, the column labels and the
  play area are **three grids sharing one column-track definition**, which is what keeps a
  tile card exactly over its column at any width.
- `src/lib/connect4/TileRail.svelte` — the 25 objective cards.
- `src/lib/server/connect4.ts` — the store: load a snapshot, and the actions (`setPool`,
  `enrolMembers`, `assignSides`, `startGame`, `claimTile`, `creditManual`, `undoClaim`,
  `syncTrackedItems`, `finishGame`).
- `src/lib/server/connect4Pool.ts` — the candidate generator (boss drops from
  `itemEhb.json` priced by `bestEhbSource`) and the auto-fill.
- `src/routes/admin/connect4/` — game list + creation; `[slug]/` is the tester.
- `db/scripts/connect4.sql` — schema. **Staging only so far**: `db/apply.sh --staging`.
- `scripts/connect4-sim.mjs` / `scripts/connect4-demo.mjs` — the simulation and the demo.

### Data model

The container is a **`vs_events` row** (`kind='connect4'`). `structure.connect4` holds the
phase, the scoring config, the sides, the curated pool, the dealt deck, the seed and the
winner. Teams reuse `vs_teams` + `vs_event_signups.team_id` like every other event.

**One table**, because only one thing here needs a guarantee the application cannot make:

| Table | The guarantee |
|---|---|
| `vs_connect4_pieces` | `unique (event_id, col, row)` **is** the "first team to the tile claims it" rule. `unique (event_id, drop_key)` **is** what makes intake safe against the reconcile pass. |

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

### Undo

Only the **top piece of a column** can be removed. Taking one from underneath would rewrite
where every piece above it landed, and the board is the record of what happened. The score,
the live tile and the winner all correct themselves, because none of them is stored.

The source is closed too, or the reconcile pass would put the piece straight back: a Dink
drop is stamped `reverted`, an outcome it does not re-surface. It is audit-logged.

### Running a game

1. Apply the schema once: `db/apply.sh --staging db/scripts/connect4.sql`.
2. `/admin/connect4` → **New game**. Set the scoring and the side names. Leave **test**
   ticked until it's the real thing — a test game refuses real Dink drops outright, so a
   staged board can never swallow a live drop.
3. **Curate 250 tiles.** *Auto-fill* spreads them across the difficulty range as a starting
   point; the filter and the checkboxes do the rest.
4. **Put members on sides.** Filter, tick, and send them to a side — one statement for the
   whole batch. This both signs them up and seats them, so it works whether or not they
   have ever touched the event.
5. **Start**, which deals the deck and opens tracking.
6. From there it runs itself. The tester can simulate a drop through the real pipeline,
   credit a column by hand, and undo a piece.

### Testing

```bash
npm run sim:connect4                  # the full game, against staging
npm run sim:connect4 -- --quick       # skip filling all 250 cells
npm run sim:connect4 -- --seed 7 --keep
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

### Known gaps / next passes

- **No member page.** Everything is admin-only. The member view is the next pass, and
  should use the instant-nav pattern (see [`PAGES.md`](PAGES.md)) with the deck stripped
  by `redactSnapshot`.
- **Balance is unvalidated.** The scoring defaults are a first pass against unmeasured drop
  rates. All three dials are per-event and retunable mid-game.
- **No three.js board.** The CSS board is the shipped one; a 3D treatment is a possible
  later pass and nothing depends on it.
- **No Discord announcements.** Completing a connect four is the natural hook, in
  `claimTile`'s report.
- **The pool is boss drops only**, and the same 25 tiles serve both clans.
- **RLS.** The new table inherits the repo's current posture (see
  [`PENDING-OPS.md`](PENDING-OPS.md) §1). `enable_rls.sql` loops every public table, so
  re-applying it covers it with no edit.
