# Events data model — the standard for new events

This is the canonical way to build **any** event, board, or bingo going forward. The goal: a new
event is mostly **data + a small strategy module**, never a new table or a new copy of the
review / progress / auto-track plumbing. Existing events (Echo Rumours, DuoWolf, the current
personal boards) are **grandfathered** — leave them; this standard governs everything new.

See also: `docs/ARCHITECTURE.md` (whole system) and `docs/event-builder-and-dink-tracking.md`
(the live Dink pipeline this generalizes).

## The three invariants
1. **One completion ledger.** Every completion — manual proof *and* every auto-tracker — is a
   `vs_submissions` row. Because all progress lives in one place, review, progress, leaderboards,
   audit and reversal are shared, not re-implemented per event.
2. **One "active + how-to-track" interface** — the `vs_active_tiles` view. Every poller (Dink,
   Temple, WoM, WikiSync) and the Dink proxy allowlist read only this view.
3. **Event-specific behavior lives in a per-`kind` TypeScript strategy, not in the schema.** No
   rules engine in SQL; no per-event tables.

## Data spine — 4 tables + 1 view (schema in `db/scripts/events_v2.sql`)

### `vs_events` — the container
One row per event **or** per personal board. `kind` selects the strategy; `owner_user_id` is null
for shared events and set for personal boards. Topology/timing lives in `structure` (jsonb).

### `vs_tiles` — the objectives
One row per board/grid tile. **Structural fields are columns; flexible bits are jsonb:**
- `meta` jsonb — display-only, kind-specific extras (`target_xp`, `ca_tier`, `ehb`, …). **Never add
  a per-kind column again — it goes in `meta`.**
- `triggers` jsonb — an array of auto-complete rules
  `{ type, match_key, required_qty, source_name }`. **Empty array = manual/proof-only.** Multiple =
  collect-N (`required_qty`) / any-of. (jsonb, not a table: triggers are few, stateless, tile-owned,
  and only ever read through the view — promote to a table later behind the same view if matching is
  ever measured slow.)

Flat "task" events (`kind='simple'|'sequential'`) keep using `vs_tasks` instead of tiles.

### `vs_event_participants` — who is "on" the event
`(event_id, user_id, team_id?, activated_at)`. Solo = user; team events set `team_id`; a personal
board's sole participant is its owner. This is who the active-tiles view fans out over.

### `vs_submissions` — the completion ledger (already exists)
Every credit is one row: `event_id, target_id (=tile_key), user_id|team_id, quantity, status
('pending'|'approved'|'rejected'), source ('manual'|'dink'|'clog'|'wom'|'wikisync'), proof_urls`.
Manual → `pending` (reviewed) or `approved` (self-serve). Auto-track → `approved`. **Progress is
derived from this ledger; there is no per-tile `obtained` flag to keep in sync.**

**Personal-board VP.** Every completed tile pays a small amount (difficulty-scaled);
completed rows/columns/diagonals and a blackout pay on top, scaled by the board's size +
difficulty with a quadratic hard-end bump (`personalVpAmounts` in `personalBoard.ts`).
Settlement is poll-on-read (`settlePersonalVp`, run on every board view): each paid
tile/line/blackout is itself a `vs_submissions` row — `target_id 'vp:t<idx>'` /
`'vp:<lineKey>'` / `'vp:blackout'`, source `'vp'`, the granted amount in `quantity` — so the
awarded set and the earned total are read straight from the ledger, and a reroll wipes them
with the board. An in-process per-user guard prevents concurrent views double-paying; the
grant goes through `grantPlayerVp` (players.points). Admin test boards carry
`structure.test = true` and never pay.

**Personal-board lifecycle.** Locking starts tracking, and a locked board never expires —
the owner keeps it as long as they want. Resetting (generating a replacement) wipes the
board + its ledger (the UI confirms) and is gated by `RESET_COOLDOWN_DAYS` (30) behind
`RESET_COOLDOWN_ENABLED` in `personalBoard.ts` — **currently `false`** (resets allowed
anytime) as a migration window for boards that predate the newer tile kinds; flip it to
`true` to require the wait, and the server gate + all page copy/buttons follow. VP farming
is self-limiting: item tiles need drops the player is still missing, so completed content
leaves the pool. The non-boss (Temple EHC) item pool excludes gilded and 3rd age pieces
outright (`COSMETIC_EXCLUDE` in `personalBoard.ts`).

### `vs_active_tiles` — the view (only interface the trackers read)
One row per **(participant × not-yet-complete tile × trigger)**, expanding each tile's `triggers`
jsonb, across open events + locked personal boards. Carries `type, match_key, required_qty,
source_name, activated_at`. Each poller filters to its own `type` (`dink_item`/`clog`/`skill_xp`/
`combat_achievement`); the Dink proxy allowlist = `select distinct match_key … where type='dink_item'`.
**Adding a tracker or an event kind needs no view change.**

## Logic layer — the per-`kind` strategy (TypeScript)
The **only** place event-specific behavior lives. Each `kind` implements:
```ts
interface EventKind {
  getTiles(event): Tile[];                 // author or generate the board
  isTileActive(tile, progress): boolean;   // unlock / gating (graphs, sequences, path choices)
  score(progress): Standing;               // leaderboard / standings rule
}
```
Shared server primitives feed it (build alongside the first v2 event): `getTiles(event)`,
`creditTile()` (insert an **idempotent** approved submission), `computeProgress()` (from the ledger),
and one `vs_active_tiles` accessor + a single "participant key" helper (`coalesce(team_id, user_id)`).

## Recipe — adding a new event

> **Need the people before you need the event?** `kind='signup'` is a list-and-questions
> event with no objectives at all, and its roster can be pushed into whatever you build
> afterwards. See [`SIGNUPS.md`](SIGNUPS.md) — it saves inventing a half-event to hold
> names in.

1. Insert a `vs_events` row (`kind`, dates, `structure` if it has topology).
2. Insert its objectives: `vs_tiles` rows (board) **or** `vs_tasks` rows (flat task event). Put
   auto-track rules in each tile's `triggers`; leave empty for manual/proof tiles.
3. Sign participants up → `vs_event_participants`.
4. Nothing else for tracking: they appear in `vs_active_tiles`; pollers auto-credit into
   `vs_submissions`; manual proof goes through `createSubmission()` and the existing
   `/admin/submissions` queue.
5. Only if the event has non-trivial gating/scoring, add a ~50-line strategy module for its `kind`.

## Known complications (and the rule for each)
1. **Unlock graphs / sequential reveals.** The view gates only simply (open + not complete + release
   time); rich unlock logic lives in `isTileActive`. **Rule:** the view is *permissive* (auto-credit
   any not-complete tile); locking is display/scoring only — never split gating across SQL and TS.
2. **Compound triggers ("A and B").** `required_qty` + any-of covers most; true AND/OR stays in the
   strategy. Don't grow a rules DSL inside `triggers`.
3. **Derived progress at scale.** The view sums approved (+pending) quantity per (participant, tile)
   vs required. Fine at clan scale; the first place to add a rebuildable projection table (behind the
   same view) if ever measured slow.
4. **Owner ambiguity (team vs solo vs personal).** Resolve one "participant key" from `kind`/`team_id`
   in a single helper and use it everywhere.
5. **Double-credit / idempotency / reversal.** Auto rows need a **dedupe key** (`source` + external
   id, mirroring `vs_dink_drops`); `vs_submissions` reversal already exists.
6. **Unvalidated jsonb.** `structure`/`triggers` have no DB constraints — validate with per-`kind` TS
   types at write time (builder save).
7. **Personal boards leak into event lists.** Reusing `vs_events` means every public/admin event
   query must filter `owner_user_id is null` — do it in one scoped accessor, never query raw.

## Legacy disposition (do not reuse for new work)
- **`vs_bingo_completions`** — KEEP, read-only. Holds Echo Rumours history we want for reference.
  No new writes; don't delete.
- **`vs_team_completions`** — already removed from the DB. Remaining code refs (review queue,
  `events/[slug]/board`, admin pages) are dead branches — clean up when convenient.
- **`vs_personal_boards` / `vs_personal_board_tiles`** — REMOVED. Personal boards were migrated onto
  this spine before release: a board is a `vs_events` row (`kind='personal'`, `owner_user_id` set),
  its tiles are `vs_tiles` rows, and completion is derived from `vs_submissions` (auto-track sources
  `dink`/`clog`/`wom`/`wikisync`, manual = `manual`). They're the reference implementation of the
  standard (see `src/lib/server/personalBoard.ts`). Public/admin event lists filter
  `owner_user_id is null` to keep personal boards out.
  - Personal tile kinds: `item` (clog/Dink), `skill` (WoM XP since lock), `ca` (WikiSync combat
    achievements), `diary` (WikiSync achievement-diary tiers, `meta.diary_region`/`diary_tier`,
    catalogue in `src/lib/diary.ts` — at most one region per board) and `clue` (grouped clue
    tiles behind the "group clue items" sub-toggle: `meta.clue_tier`/`clue_target`; any
    `clue_target` uniques gained in that tier **since `locked_at`**, counted from Temple's
    own category + per-item date by `clueGainsSince`; synthetic negative item ids per tier;
    completion + `meta.clue_progress` come from the Temple clog re-poll, not Dink). CA + diary
    state share one WikiSync read (`getWikiSyncState`); only `item` tiles are Dink-trackable
    (`active_tiles.sql`).
  > **Why clue progress does not use `meta.clue_candidates`.** It used to, and every
  > hard/elite/master clue tile was consequently unwinnable. Candidates are frozen at
  > generation from `itemEhc.json`, and that file's builder keeps an item only when Temple
  > values it above zero — but Temple reports `hours: 0` for a slot the player OWNS, so
  > every item the sampled (deep-log) accounts all owned was dropped. `hard_treasure_trails`
  > came out with 11 items that overlap by **zero** with what players actually pull from hard
  > clues: one member owned 100 hard uniques and had gained 16 since locking while her tile
  > read 0. Counting from Temple's category + date needs no catalogue of ours to be complete,
  > and it heals an affected board on its next refresh. `clue_candidates` is still written at
  > generation (it is what prices the tile) but is no longer read for progress.
  >
  > The date is safe to trust for this: a slot obtained before the player's first Temple sync
  > carries the sync stamp instead of a real date, but generating a board REQUIRES a Temple
  > log, so that stamp always predates the lock. `scripts/clue-progress-check.mjs` pins that
  > case down — if it ever regresses, every long-standing player's clue tiles would complete
  > the moment they refreshed.
  > **Rebuilding `itemEhc.json` needs a THIN account in `--player`.** An item's value comes
  > from a player who LACKS it (`missing_hours`); a player who owns it reports `hours: 0`.
  > The values endpoint returns the whole ~1712-id catalogue for anyone, so one low-log
  > account values nearly everything, while deep logs supply the names and categories (the
  > catalogue endpoint lists only owned slots). Built from deep logs alone, every item those
  > accounts all owned valued 0 and was dropped — which is how `hard_treasure_trails` ended
  > up with 11 items. Items Temple genuinely values at 0 are now kept at a 0.01h floor
  > rather than dropped, so they rank last and stay off high-difficulty boards instead of
  > vanishing. Always `--player` the union of everyone used before plus the new ones: the
  > catalogue is a union and values are a max, so adding players can only improve both.
  - Item pool: boss drops from `itemEhb.json` (curated EHB math, `build_item_ehb.mjs`) always;
    plus non-boss clog items from `itemEhc.json` (Temple per-item EHC, `build_item_ehc.mjs` —
    maintainer-run) behind the "Include non-PVM collection log items" toggle. Both pools share
    the id-keyed pin/exclude overrides (`vs_ehb_overrides`, /admin/ehb) and the same completion
    paths (Temple clog poll + Dink COLLECTION).
