# Gielinor Catan — ruleset & MVP tester

An asynchronous, team-based OSRS bingo event built on the Catan engine. Instead of a
checklist of drops, the bingo *is* a board game: teams build settlements and roads on a
shared hex map, grind in-game to earn resource tokens, trade, and race to **10 Victory
Points**. First balance target: **8 teams of 4**.

This doc is both the ruleset (working draft — numbers are first-pass and meant to be
tuned) and the map of the MVP tester implementation.

---

## Part 1 — Ruleset

### Core concept

- One **shared hex map**, Catan geometry. Tiles generate tasks; teams build **settlements
  on corners** and **roads on edges**. A corner earns from all 2–3 tiles it touches.
- Fully **asynchronous** — teams act on their own cadence, no turn order, no waiting.
- Three things matter at once: **luck** (in-game RNG), **effort** (grinding tasks), and
  **strategy** (map position + trade).
- **First team to 10 VP wins.**

### The board

**37 hexes** (a radius-3 hexagon, rows 4-5-6-7-6-5-4) — sized for 8 teams. For scale:
classic Catan is 19 hexes / 54 corners for 3–4 players; the official 5–6 player extension
is 30 hexes. 37 hexes gives 96 corners and 132 edges, enough room for 16 initial
settlements under the distance rule with expansion space left over.

Every tile has two properties:

- **Type:** Boss (12), Skilling (12), Raids (4), or Custom (9). Raids tiles are
  deliberately rare **and placed at least 3 hexes apart** — scarcity lives in the map,
  not in a rule (see "Raids scarcity" below).
- **Rating 1–5:** sets task difficulty. **Lower is better** — a rating-1 tile mints its
  token for minimal effort; a rating-5 makes you grind ~5× as much for the *same* token
  (linear scaling).

Rating distribution over 37 tiles (inverted pyramid — good tiles scarce):

| Rating | Tiles | Share | Feel |
|--------|-------|-------|------|
| 1 | 2 | ~6% | Prime real estate — contested |
| 2 | 5 | ~13% | Strong |
| 3 | 7 | ~19% | Average |
| 4 | 10 | ~27% | Grindy |
| 5 | 13 | ~35% | Heavy grind |

### Tasks

- All tasks are expressed in **KC / EHB / EHP** — no drop-count tasks, so every task is
  continuously scalable and low-variance. The tile's **rating sets the size of the
  grind** (linear: rating 5 ≈ 5× rating 1 for the same token).
- Each tile carries 3 candidate tasks, sampled at board creation from the
  **admin-editable task pools** (`/admin/catan/tasks` — one list per tile type, each
  entry = task name + unit + per-rating amount; stored in `vs_catan_config` under
  `task_pools`, with code defaults in `src/lib/catan/board.ts` until first saved).
  Existing games keep the tasks their board was generated with.

**Rolling (asynchronous).** On your own cadence: roll one of your corners → randomly
selects one of its 2–3 tiles → randomly selects a task on that tile → complete it → earn
tokens of that tile's type. No waiting on other teams; **task magnitude is the pacing
throttle**.

**Same-type multiplier.** Completing a task pays **1 token per distinct tile of that type
your network is adjacent to** (uncapped, like same-number stacking in Catan). A tile
adjacent to one of your **cities** counts double (a city doubles that corner's output).
Raids stacking is checked by map placement, not a cap.

### Currency

**Boss (B) · Skilling (S) · Raids (R) · Custom (C)** — B/S/C are the common tokens that
run the base game; **R is precious** (single scarce source, the heavy component of
Cities).

**Gold** is the separate luck currency: boss purples (1), raids purples (2), and
time-gated bonus tasks on Skilling/Custom tiles (1 each; 0–3 hidden triggers per tile
over its life). Gold trades **2:1 for any tile token**, and never buys VP directly.

### Building & costs

| Build | Cost | Yield |
|-------|------|-------|
| **Road** (edge) | 1 S + 1 C | Extends your network; must connect to it |
| **Settlement** (corner) | 1 B + 1 S + 1 C | **1 VP**; distance rule; must sit on your road network |
| **City** (upgrade) | **2 R + 2 S** | **+1 VP** (2 total); doubles that corner's output |
| **Dev card** | 1 B + 1 S + 1 C | Random draw from the development deck |

**Setup — snake draft (Catan standard):** in team order each team places 1 free
settlement + 1 free road, then the order **reverses** for the second placement
(1→8 then 8→1; 16 turns total). A setup settlement obeys only the distance rule; the
setup road must attach to the settlement just placed. Until the draft finishes, all
other actions (rolling, buying, trading, dev cards) are locked. The turn is derived
statelessly from the board (completed turns = roads placed), so there is no draft
bookkeeping to corrupt.

### Trading

| Method | Rate | Access |
|--------|------|--------|
| **Bank** | 4:1 | Always |
| **Generic port** | 3:1 | Settle the port's corner |
| **Specific port** | 2:1 (that type) | Settle that port's corner; one per token type |
| **Gold exchange** | 2:1 (gold → any token) | Always |
| **Team-to-team** | Any agreed rate | Bot escrow — **not in the MVP tester** |

The board carries **7 ports**: one 2:1 per token type (4) + three generic 3:1, spaced
evenly around the coast. A port is granted by a settlement/city on either of its edge's
two corners.

### Victory points

| Source | VP | Notes |
|--------|----|----|
| Settlement | 1 each | |
| City | 2 each | |
| **Longest Road** | 2 | Longest continuous road, min 5; rival buildings break the path; stealable only by strictly exceeding the holder |
| **Largest Army / "Bounty Hunter"** | 2 | Most PKer cards played, min 3; same steal rule |
| **Hidden VP** dev cards | 1 each | Secret until game end |

### Development deck (25 cards)

| Card | Count | Effect |
|------|-------|--------|
| **PKer** (Knight) | 14 | Freeze a rival corner for 24h (no rolling from it). Most played = Bounty Hunter (2 VP) |
| **Hidden VP** | 5 | Secret +1 VP, revealed at game end |
| **Bond** (Monopoly) | 2 | Name a token type; every team hands you all they hold |
| **Birdhouse Run** (Year of Plenty) | 2 | Take any 2 tokens from the bank |
| **Agility Shortcut** (Road Building) | 2 | Your next 2 roads are free |

### Open items (parked)

- **Rerolls** (task-reroll / rating-reroll) as token sinks — in or out?
- **Master dial** — event length locks the ~40-task target and rescales all costs.
- **Real task lists** per tile type (MVP uses placeholder pools).
- **Team-to-team escrow trading** via the bot.
- **Time-gated gold tasks + drop feed** — the tester simulates all gold income via the
  Grant cheat; the live event needs the notification/window machinery and Dink wiring.
- **Live-event spine integration** — record completions in the `vs_submissions` ledger
  (per `docs/EVENTS.md`) once real players submit proof; the tester records completions
  in `vs_catan_tasks` only.

---

## Part 2 — MVP tester implementation

The tester lets **one admin play every team** and drive a full game by hand at
`/admin/catan` (linked from the admin hub, `isAdmin`-gated).

### Where things live

- `src/lib/catan/geometry.ts` — pure hex math (pointy-top, axial coords). Canonical ids:
  hex `"q,r"`, vertex `"q,r,N|S"` (every corner is the north or south corner of exactly
  one hex), edge `"vidA|vidB"` (sorted endpoint pair). Verified counts for radius 3:
  37 hexes, 96 vertices, 132 edges, 42 coastal edges.
- `src/lib/catan/board.ts` — deterministic board generation from a seed (tile types,
  ratings, raids spacing ≥ 3, task pools, 7 ports evenly spaced on the coast).
- `src/lib/catan/rules.ts` — pure rules over a `GameSnapshot`: costs, placement
  validation (distance rule, road connectivity, rival-corner blocking), same-type
  multiplier payouts, trade rates, longest road (DFS trail, broken by rival buildings),
  largest army, holder steal semantics, VP breakdown, legal-spot enumeration.
- `src/lib/catan/BoardMap.svelte` — the SVG board (tiles, rating chips, ports, roads,
  settlements/cities, freeze rings, click targets for legal spots).
- `src/lib/server/catan.ts` — store + actions: loads rows, builds a snapshot, validates
  through the rules, writes, logs. Single-tester read-modify-write; concurrency needs a
  revisit before real teams play simultaneously.
- `src/routes/admin/catan/` — game list/create/delete; `[slug]/` — the tester page
  (act-as-team selector, board click modes, tasks, economy, dev cards, standings, log).
- `db/scripts/gielinor_catan.sql` — schema (below). Apply by hand in the Supabase SQL
  editor **after** `events_v2.sql`.

### Data model

The game container is a **`vs_events` row** (`kind='catan'`, `status='draft'` so test
games stay out of public lists and the bot's announce poller). `structure.catan` holds
the generated `board`, the remaining shuffled `deck`, the stealable-bonus `holders`,
active PKer `freezes`, and a capped action `log` (newest 200; the tester's debug feed —
admin POSTs are additionally captured by the standard `vs_audit_log` hook).

Deliberately table-light — only state that needs a database-level guarantee gets a table
(both `on delete cascade` from the event):

- `vs_catan_teams` — 8 rows/game: name, color, `tokens` jsonb (B/S/R/C/gold),
  `free_roads`, plus two jsonb columns that ride on the team row's write atomicity:
  `hand` (dev cards: `{id, card, drawn_at, played_at, meta}`) and `tasks` (rolled tasks
  with their snapshot + payout; finished history capped at 30, active always kept).
- `vs_catan_pieces` — one row per road/settlement/city; `unique (event_id, loc)` doubles
  as the occupancy rule (vertex and edge ids never collide).
- `vs_catan_config` — key/value tuning knobs (`task_pools` today; cost dials later).

Every action is a single structure write: holders are recomputed against the in-memory
snapshot (`stageHolderChanges`), not via a reload, keeping placement latency to
insert + one jsonb update.

**Client-side prediction.** Because the rules engine is pure and shared, the tester page
runs it in the browser against a local copy of the snapshot: placements validate, render,
pay costs, update holders, and advance the draft **instantly**; the POST trails behind on
a serialized background queue (so requests can't race), with one coalesced refresh after
a burst. The server stays authoritative — any rejection or network error surfaces the
message and resyncs the local state from a full reload. Actions the client doesn't model
(rolling, dev cards, trades) still use the normal submit-and-reload flow.

Live-event follow-up: task completions mirror into the `vs_submissions` ledger
(per `docs/EVENTS.md`) once real players submit proof.

### How to test a game

1. Apply `db/scripts/gielinor_catan.sql` (once).
2. Optionally curate the task lists at `/admin/catan/tasks` first.
3. `/admin/catan` → **Create test game** (optionally pin a seed for a reproducible board).
4. Run the setup snake draft: the banner names whose pick it is; the **Place as …**
   button (and each placement's auto-advance) keeps you on the right team with the right
   mode armed, so the 16 turns are just clicks around the map.
5. Play: **Roll task** on a corner → **Complete** it (pays the same-type multiplier) —
   or use the **Grant** cheat to simulate income (e.g. +2 gold for a raids purple)
   without the grind. Build, trade at bank/port rates, exchange gold, draw and play dev
   cards. Standings show public VP vs true VP (hidden VP included); the winner banner
   fires at 10 true VP.

### Verification

`npm run check` and `npm run build` pass. The rules and store were exercised end-to-end
by simulation (geometry invariants; board distributions across seeds; a full scripted
game through `src/lib/server/catan.ts` against a mock of the Supabase query surface:
8-team setup, placement rules, rolling/completion payouts, trading, gold, the whole
25-card deck, freezes, holder steals, winner detection, cascade delete). There is no
automated test suite in the repo; re-verify manually against a real database after
applying the SQL.
