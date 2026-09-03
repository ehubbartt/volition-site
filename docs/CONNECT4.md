# Connect Four — ruleset & implementation

A clan-vs-clan event where the board game **is** the bingo. One shared board (sized per
game; classically **25×10**); above each column sits a boss drop. The first team to get
that drop claims the column — their piece falls to the lowest empty row, exactly like the real game, and a new
tile drops into the slot above. Connect four in a row to score, and keep going: longer
lines pay more.

Sized for **120 v 120**, but nothing in it depends on the headcount.

This doc is both the ruleset (numbers are first-pass and meant to be tuned) and the map of
the implementation. See also [`EVENTS.md`](EVENTS.md) for the shared events spine and
[`event-builder-and-dink-tracking.md`](event-builder-and-dink-tracking.md) for the drop
pipeline this hangs off.

> **Status: staging-only.** The schema is applied to staging alone. Games are driven from
> `/admin/connect4`; members watch (read-only) at `/events/[slug]/connect4`.

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
`structure.connect4.size`; the classic board is 25×10). cols × rows cells means exactly
that many curated tiles — filling the board consumes the whole deck. Older games with no
stored size are 25×10.

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
  source for its whole priced drop table, and/or type a list); every member is projected
  into the Dink allowlist, and the qualifying list shows on the hover card, the detail
  strip and the CSV. A group tile's icon is its first member's.
- **Quantity tiles** (`qty`) — "×3": one side needs that many qualifying drops, and the
  FIRST side to its Nth drop claims the tile. Per-side progress lives in
  `vs_connect4_progress` — one row per qualifying drop, `unique (event_id, drop_key)`
  exactly like the pieces, so the reconcile pass can re-run a counted drop forever and
  it stays one drop; the Nth drop claims the piece with the same drop key. Progress
  drops are stamped `partial` in /admin/dink-drops. Set the ×N in the curation list
  (a number input on every ticked tile) or on the custom-task form. An admin's manual
  column credit claims a qty tile OUTRIGHT — crediting means the tile is decided, not
  one more drop toward it — and an undo leaves banked progress standing, so the next
  qualifying drop re-claims it; clear `vs_connect4_progress` rows by hand if the undo
  was meant to reset the race.

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

**One table**, because only one thing here needs a guarantee the application cannot make:

| Table | The guarantee |
|---|---|
| `vs_connect4_pieces` | `unique (event_id, col, row)` **is** the "first team to the tile claims it" rule. `unique (event_id, drop_key)` **is** what makes intake safe against the reconcile pass. |
| `vs_connect4_progress` | Per-side drops banked toward a QUANTITY tile, keyed to the deck slot. Same `unique (event_id, drop_key)` guard as the pieces. |

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
   250-cell board therefore leans on **copies**, **×N quantities**, group tiles and custom
   tasks for headroom, not on a bigger generated list. The **Generate**
   filter row (stored per game) sets min/max EHB and toggles pets, jars and
   3rd age/gilded; it shapes what the list OFFERS and what the fills draw from, and never
   invalidates already-ticked tiles (saving validates against the unfiltered universe).
   *Auto-fill* spreads across the difficulty range deterministically; *Random fill* keeps
   the spread but rolls different tiles every click. Every ticked tile gets two knobs:
   **×N** (drops one side needs to claim it) and **⧉N copies** (the same tile in N deck
   slots, each copy its own race — extra drops while copies remain stay `no_tile` and can
   credit later, never `raced`). **Custom tasks** — anything the generated list doesn't
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
`src/lib/server/clan.ts`: in it → Volition, not in it → the visiting clan. Discord id first,
then RSN case-insensitively with `_` and ` ` treated as the same character. Deliberately NOT
`vs_users.clan_allegiance`, which is a free choice on the onboarding form and would let
anyone put themselves on either side.

`seatByClan` (server) + the **Seat everyone from…** control in the tester's Teams panel do
the split in one go: pick the signup form the roster was collected on, preview, then seat.
Seating also signs everyone up to the game, which is what puts them in the Dink allowlist.

> **Preview before you seat, and read the flagged list.** The rule's failure mode is a real
> Volition member whose site account was never linked to their `players` row — no Discord
> match and an RSN that does not match either — who lands with the visitors. The report
> calls out anyone in that bucket whose own profile says `volition`; on the staging clone
> that is 27 of 104 non-matching accounts. The per-member → *side* buttons fix the rest.

Costs two queries regardless of size: a 135-person roster splits in ~290ms.

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
