# Battleship — ruleset & implementation

A team-vs-team OSRS event where the board game **is** the bingo. Two captains draft the
signup pool into two fleets, each side hides its ships on its own grid, and then the only
way to attack is to play the game: **any drop you get becomes a bomb**, and the bigger the
drop the bigger the hole it makes in the other side's water. First side to sink the enemy
fleet wins.

Sized for **80 players** (40 a side, a 25×25 board) but it scales to whoever actually signs up.

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
picked"). Side 1 — Captain 1's side — always picks first; the engine takes a `firstSide`
but the admin form doesn't offer it, so putting a captain in the **Captain 1** slot is how
you give them first pick. With an odd pool the side picking first ends up one player larger.

**One screen makes the picks.** The pick board lives on the admin page and is admin-only;
in practice an admin drives it while both captains call their picks, usually over a shared
stream. To make that work the board does four things:

- A banner names the fleet the next click will feed — **by name and in its colour**, with
  its captain and the pick number. "Side 1" is not what anyone calls their team, and a pick
  cannot be undone from this page. The pool buttons carry the same colour, so the thing you
  click looks like the fleet it feeds even once the banner has scrolled away.
- It renders the **whole** pool. It used to stop at 40 names, which at 80 signups left half
  the pool unpickable — a captain could call a name that simply wasn't on screen.
- A filter finds a called-out name without scanning a wall of buttons.
- Every pick raises a **modal announcing who went where and at what pick number**,
  dismissed by clicking it. A name silently moving between two lists is invisible on a
  stream.

> **Side colours follow the default names**: side 1 is `#ef4444` (Fleet **Red**), side 2 is
> `#3b82f6` (Fleet **Blue**). They were the other way round until the draft banner put the
> name and the colour side by side and made it obvious. Games drafted before that fix keep
> the colours stored on their `vs_battleship_teams` rows.

Captains and members get the undrafted pool on **their own** page for the whole draft, to
read rather than click. `draftPick` still enforces the turn rule and claims a member with a
conditional write (`… where team_id is null`), so two simultaneous picks of the same person
produce one pick — the guards for a captain-facing pick screen already exist if that's ever
wanted; only the UI doesn't.

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

`startBattle` replaces anything that is not a **complete, correctly-sized** fleet for the
current board — not merely anything empty. The earlier test ("has ships, and each has
cells") would pass a side into battle with 20 ships against 31, or with a fleet built for a
smaller board. Neither is reachable through `placeFleet`, which rejects an incomplete
fleet, but a repair or a board-size change can leave one behind, and this is the last gate
before it becomes the game everyone plays.

### The board scales with the draft

Water per player is fixed (**15 squares**), so the grid grows with the headcount — bombs
arrive in proportion to headcount, so board area has to as well or a big event just
saturates its board:

| Players | Per side | Board | Squares | Ships | Ship squares |
|---|---|---|---|---|---|
| 12 | 6 | **10×10** | 100 | 5 | 17 |
| 32 | 16 | 16×16 | 256 | 13 | 46 |
| 48 | 24 | 19×19 | 361 | 18 | 63 |
| 60 | 30 | 22×22 | 484 | 24 | 83 |
| **80** | **40** | **25×25** | **625** | **31** | **107** |
| 100 | 50 | 25×25 (capped) | 625 | 31 | 107 |

**A 12-player event is exactly the classic 10×10 board with the classic 5/4/3/3/2 fleet.**
Bigger boards keep the same ~17% ship density by adding more ships, not longer ones.
Bounds are 8×8 and 25×25; an admin can pin an exact size when creating the event.

> **This dial has been raised twice.** At 6 squares per player, 60 players got a 14×14
> board and the rehearsal took 185 shots on 196 squares to finish — i.e. it ran until the
> board was nearly all craters, and that was with *random* targeting. Real players hunt
> around their hits, so they'd have got there much sooner. 12 doubled the water; 15 is set
> from the event actually being run — 80 players on 25×25. It's still a guess against
> unmeasured drop rates: raise it further if events end too quickly.

> **25×25 is the ceiling, and it's a display limit rather than a game one.** Past that a
> grid stops reading as a board: cells fall under a comfortable size on a desktop viewport,
> and a phone has to scroll through more of the board than it can show. A larger event gets
> a longer event, not more water.

Ships are placed horizontally or vertically, may **touch** but not overlap (standard rules).

### Drops become bombs

Any **single drop** a member gets during the battle is checked against three tiers. The
value is the stack's value (quantity × unit price), never the summed total of a kill — the
same rule the Discord drop feed already uses, so a herb-run dump of cheap stacks can't add
up to a bomb.

| Tier | Drop value | Bomb | Squares |
|---|---|---|---|
| Cannonball | 5m+ | 1×1 | 1 |
| Bombard | 20m+ | 2×2 | 4 |
| Broadside | 60m+ | 3×3 | 9 |

All three thresholds are set per event when it's created, and are shown to players on the
event page — read straight off `config.tiers`, so retuning them mid-event updates what
everyone sees without a deploy.

> **Keep the array sorted by `min_value`, cheapest first.** `vs_value_tracked_rsns` reads
> `structure #>> '{battleship,tiers,0,min_value}'` to tell the dink-proxy what gp floor to
> record at. Put the biggest tier first and the proxy stops recording everything below it
> — the bombs simply never arrive. `tierForValue` itself doesn't care about order; the
> view does.

**Retuning tiers mid-event** is supported and is the intended lever when the pace is
wrong. Two things move: the event's own `config.tiers`, and the bombs already banked
against the old numbers. `db/scripts/battleship-retier.sql` does both in one transaction
and never demotes a banked bomb — see the header of that file.

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

A bomb is aimed at a square on the enemy grid and the blast **wraps around the square you
clicked**: a 3×3 puts it in the middle, a 1×1 is the square itself. A 2×2 has no middle
square, so the click becomes its top-left — the invariant is that *the square you clicked
is always inside the footprint*, which is what makes aiming predictable. The whole
footprint has to land on the board, so near an edge it slides inward to fit (every square,
corners included, is still reachable).

`anchorFor(cell, span, size)` does that click→anchor translation and lives in the rules, so
the hover preview, the committed highlight and the shot actually fired cannot disagree.
Storage is unchanged: `vs_battleship_shots` still records the **top-left** anchor and
`bombCells` still expands from it.

Each covered square is a hit or a miss, exactly like the real game: hits show, misses show,
and a ship is announced as sunk once every one of its squares is hit. Squares that were
already cratered are skipped rather than counted twice — and if *every* square of a bomb
was already hit, the shot is refused and the bomb stays banked instead of being wasted.

**What each side can see:** the craters on the enemy's grid and which of their ships are
sunk — never their ship positions. **Your own fleet is visible to your CAPTAIN only**, not
to your teammates: a fleet known to 43 people is one screenshot in the wrong Discord
channel away from not being a secret. Members still get the enemy grid, so they can aim
and fire the bombs they earn; the positions are the secret, not the board. A member also
sees their side's health as counts ("96/107 squares afloat"), which reveals nothing.

Placement is captain-only for the same reason — anyone who can *write* the fleet knows it
afterwards, and could overwrite the captain's. All of this is enforced server-side (see
`redactFor` and the `place` action), not by the UI.

> **An admin who is PLAYING is redacted like anyone else.** Only a non-participant admin
> (running the tester, or spectating) receives both fleets. This matters because at a clan
> event the captains are usually admins — leaving admins unredacted would have let a
> captain read their opponent's board.
>
> **The admin tester goes through the same redaction.** It used to return the raw snapshot,
> which was fine while it was only a tester and stopped being fine the moment admins were
> playing: opening the page showed them their opponent's ships, and hiding the boards in the
> UI would not have helped, because the positions would still have been in the page payload.
> A playing admin now gets craters only, exactly as a player does.
>
> **And the boards start hidden**, even for a genuine spectator, behind a *Show the boards*
> toggle that resets on every load. Someone opening the tester during a live event — or
> sharing their screen — should not have both fleets on it before they have decided to look.

**One board at a time.** The battle page shows *either* the enemy's water or your own,
never both, chosen with a labelled switch — two 25×25 grids side by side shrink each into
something you squint at, and "which of these is mine?" should not be a question you answer
from a small heading. It opens on the **enemy's** board, because firing is the page's job
and a board you can't fire at is a worse landing place than one you can. Arming a bomb
switches you there too, so a player reading their own damage doesn't have to find the
switch before they can aim.

**Aiming.** Hovering a square previews the footprint, and *clicking commits it*: the chosen
squares stay lit until you fire or pick elsewhere, and the button reads "Fire at F7". The
preview alone is not enough — it follows the pointer, so it vanishes exactly when you move
to the Fire button, and on a phone there is no hover at all.

**The fleet key** (`FleetKey.svelte`, the *Ship types* panel) is what turns "somewhere in
625 squares" into a plan. It groups both fleets by hull length, draws each class at its
real size, and shows how many of each are still afloat — collapsed by default, and opening
on the enemy's since that's the one you aim at.

The line that earns the panel is the **shortest hull still afloat**. That number is the
search spacing: if nothing under 3 squares is left, a shot every third square cannot miss
all of them, and two thirds of the board stops being worth a bomb. It only renders for the
enemy fleet — on your own it would be advice about shooting yourself.

It reads `fleetSummary`, which `redactFor` already puts on every snapshot for **both**
sides, so the panel widens nobody's view: ship sizes and sunk flags are exactly what a real
game reveals when something goes down.

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
- `src/lib/battleship/FleetKey.svelte` — the *Ship types* panel described above. Pure
  presentation over `fleetSummary`; a native `<details>`, so it collapses without JS. Class
  names are derived from the ship names rather than a second copy of `CLASS_BY_LEN`, so a
  rename in `rules.ts` can't leave the key disagreeing with the board.
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

**Only LOOT notifications arm bombs.** A new collection-log item makes Dink send *two*
notifications for one drop, seconds apart: a LOOT one (source = the NPC) and a COLLECTION
one (source = `Collection log`). They carry different sources — and often different
quantities and values, since the loot notification reports the whole stack and the
collection one a single item — so they hash to different `drop_key`s and `earnBomb`'s
idempotency cannot tell they are the same drop. The consumer skips `notif_type =
'collection'` for bombs only.

Tiles still match either notification on purpose: crediting the same tile twice is a no-op,
so "watch both ways" is right for them. A bomb is minted **per drop_key**, which is why the
same rule doubled every big drop the first time an event ran.

**A drop arms a bomb in exactly one event.** `activeBattleshipFor` picks it, and the pick
is ordered: a **real** event beats a **test** one, and the newest wins the tie. Unordered
it was whichever row PostgREST returned first — which meant a test game left running in the
`battle` phase silently swallowed drops meant for the live event. (The 80-player simulation
found this the hard way, against a preview game that was still open.)

Two more rules it inherits from the rest of the pipeline: a drop received **before** the
battle opened arms nothing, and re-running a drop mints nothing further (the reconcile pass
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
5. When signups close, pick the two captains and **start the draft**. Picks are made at
   `/admin/battleship/<slug>`, which is **admin-only** — there is no captain-facing pick
   screen, so an admin drives the board while the captains call their picks (they can
   follow the pool on their own page). Each pick raises an announcement modal; the filter
   finds a name; "Auto-draft the rest" drains whatever is left.
6. The pool emptying opens the **1-hour placement window**; members hide their fleets.
7. The battle opens on its own at the deadline. From there it runs itself: drops arm
   bombs, members fire them, and the event ends when a fleet is gone.

The tester at `/admin/battleship/<slug>` can drive every one of those steps by hand as
either side — including granting bombs — so a whole game can be rehearsed without waiting
on real drops.

### The two-person dress rehearsal

The simulation and the Playwright rehearsal both drive the app as one process. Neither
answers "does this work for a second human on their own phone" — nobody but the maintainer
has ever loaded the page. This is how to check that with one other person.

**Three things to settle before you start.**

| | Why it blocks a two-person test | Options |
|---|---|---|
| `STAGING_ADMIN_ONLY = 'true'` (`fly.staging.toml`) | Staging refuses non-admins, so your tester can't load the site at all. | Set it `'false'` and redeploy staging, **or** run the rehearsal on prod as an `unlisted` + `test` event. |
| The proxy's value-tracking change is undeployed | No real drop arms a bomb. | Test the manual-claim and admin-grant paths instead, **or** `npx wrangler deploy` in `dink-proxy` first. |
| The draft is admin-only | A non-admin captain can't make their own picks — though they *can* watch the pool from their own page. | Drive the draft yourself while they call picks (the intended flow), **or** grant the other captain an admin role. |

**Two players gets an 8×8 board with three ships** — the minimum — which is exactly what
you want for a mechanics run: a game ends in a few bombs. Do that pass first, then, if you
want to see the real thing, create a second game with the size pinned to **25** and use the
random-placement button rather than placing 31 ships by hand.

1. **Create.** `/admin/battleship` → New game. Tick **test** (so it's deletable afterwards)
   and **unlisted** (so it stays off the events list). Leave the size blank.
2. **Join.** Both of you open `/events/<slug>/battleship` and join. Have them **leave and
   rejoin** — that path is self-serve only until the draft starts.
3. **Draft.** `/admin/battleship/<slug>` → choose both captains → start the draft → pick,
   or auto-draft the rest. Check their screen reads "Draft in progress".
4. **Place.** Both place fleets on the player page (or hit random), then lock in. **Check
   they cannot see your board** — their second grid should be empty water.
5. **Open the battle** from the tester, or wait out the placement window.
6. **Arm a bomb.** Two paths worth exercising:
   - *Manual claim* — the one most members without Dink will use. Player page → "Not using
     Dink? Claim a drop" → item, value, screenshot. Approve it at `/admin/submissions` and
     the bomb lands in their arsenal. Only one claim can be pending per member at a time.
   - *Admin grant* — the tester's "+Cannonball / Bombard / Broadside" buttons, for ammo on
     demand.
7. **Fire.** Pick a bomb under **Your bombs**, click a square on the enemy grid — the
   footprint stays lit and the button reads "Fire at F7" — then fire. Worth checking: hits
   and misses both render, a sink is announced, and a **non-captain has no fire button on a
   teammate's bomb** in Team arsenal (the captain does).
8. **Finish** by sinking the last ship, then delete the game from `/admin/battleship`.

> **The page does not poll — it has a Refresh button instead.** Nothing arrives on a
> timer: a draft pick or an enemy shot lands without the open page knowing. **Refresh**
> (on the draft panel and beside the board switch) re-fetches in place via
> `invalidateAll()`, deliberately *not* a browser reload, which would throw away the bomb
> you have armed and the square you have aimed at. Whether that's enough, or whether the
> battle phase should poll on its own, is still worth deciding before the real event.

### Testing

**A game to click through.** The simulation and the rehearsal both clean up after
themselves, which is the opposite of what you want when you're testing by hand:

```bash
npm run demo:battleship                      # 80 in the pool, signups open
npm run demo:battleship -- --phase battle    # skip straight to a live battle
npm run demo:battleship -- --phase battle --member --slug member-view
npm run demo:battleship -- --players 12 --slug tiny-test
npm run demo:battleship -- --delete          # remove it again
```

**`--member` is how you see a member's view.** Without it you are captain of Fleet Red and
see your own fleet; with it the captaincies go to the next two on the roster and you are
drafted onto Fleet Red as an ordinary player. Being an admin does not override the
redaction once you are on a side, so signing in as yourself is enough to see either view —
no second account and no session-minting required. You get bombs of your own either way,
plus a teammate's, so "yours to fire" versus "theirs" is visible from both roles.

It leaves a `test` + `unlisted` event at `test-battleship`, parked at `signup`, `draft`,
`placement` or `battle`, with you first in the pool (and captain of Fleet Red past the
draft) so the player view has a side of its own. Re-running replaces the game, so it
doubles as a reset. It refuses to delete an event that isn't marked as a test.

The pool is filled with **real roster members as stand-ins**, not invented accounts: fake
`vs_users` rows would land in the member counts and rank tables the home page builds from
that table. That's safe on staging, which takes no live Dink traffic (the proxy points at
prod), so a real member sitting in a test battle there can't have a drop land in it. Don't
point it at a database that *does* take live drops.

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

### Undoing a bomb

`/admin/battleship/<slug>` lists **All bombs** — every bomb on both sides, spent and
unspent, with who earned it and where it came from. The firing panel above it only ever
shows the acting side's *unspent* ones, so before this the only way to reverse a bomb that
should not exist was SQL.

`removeBomb` does three things together, because doing fewer would leave a lie behind:

1. **Its craters go too.** A fired bomb wrote one `vs_battleship_shots` row per cell, all
   sharing its `bomb_id`. Leaving them would keep the damage while removing the
   ammunition — the enemy fleet would stay hit by a shot that no longer exists.
2. **It cannot come back.** Minting is idempotent on `unique (event_id, drop_key)`, so
   deleting the row *removes* that protection and the next mint pass would recreate it. The
   source is closed as well: a manual claim is set back to `rejected`, a Dink drop is
   stamped `reverted` (an outcome the reconcile pass does not re-surface). Admin grants
   have no upstream row and need nothing.
3. **A decided game can become undecided.** If the craters that finished a fleet are among
   those removed, the winner is no longer the winner, so the game reopens rather than
   sitting on a result its own board contradicts.

It's audit-logged — taking ammunition off a side mid-event should be answerable for
afterwards — and there is no undo.

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

**One pending claim per member at a time.** The value is self-reported, so the only real
check is a human looking at the screenshot — and someone firing off ten claims for the same
drop makes it far likelier one slips through on a busy queue. Note that *inflating* a value
buys nothing beyond the top tier: 999b and 50m both arm a 3×3.

> **Staging needs the `vs-bingo-proofs` storage bucket.** Prod has it; staging did not,
> which silently broke every proof upload (not just Battleship's) with "Bucket not found".
> Created to match prod: public, no size limit, no MIME restriction.

### The full-event rehearsal

`e2e/battleship-full-event.spec.ts` is the dress rehearsal — a whole 80-player event
driven through the real UI:

```bash
BATTLESHIP_FULL=1 npx playwright test e2e/battleship-full-event.spec.ts
```

It runs at **two viewports** — set `BATTLESHIP_MOBILE=1` for a 390×844 touch phone —
because the board is the risk and a desktop run can't answer "can a person actually place
a ship and aim a bomb at this size". Both runs assert the page never scrolls sideways, the
cells stay square, and (on mobile) that cells clear a 24px tap floor. Screenshots land in
`e2e-shots/desktop/` and `e2e-shots/mobile/`.

> **Phones get a cell-size floor, not smaller cells.** A 25×25 board on a 390px screen
> would give ~10px cells — far under what a thumb can hit, and a mis-tap here *fires a
> bomb at the wrong square with no undo*. Below `--min-cell` (26px) the board scrolls
> **inside its own box** rather than shrinking, with the row numbers pinned so you can
> still say where you hit. The page itself never scrolls sideways.

Skipped unless `BATTLESHIP_FULL=1` so the normal suite stays fast. It seeds 80 players,
signs **two browser contexts in as two different captains** (minting session rows directly
rather than adding an auth surface, since dev-login only signs in the owner), drafts from
both, places both fleets through the placement editor, feeds the battle with Dink payloads
shaped exactly like the proxy writes them plus a manual claim through the review queue,
and fires until a fleet is gone. Screenshots of every stage land in `e2e-shots/`.
