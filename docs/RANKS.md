# Ranks — composite scoring, checking, and manual gear claims

The clan rank is a weighted composite of seven components, scored server-side from three
external sources plus two internal ones (manual gear claims and the site's Volition TCG
collection). This doc is the map; the code carries the detail.

## Scoring pipeline

- **Pure math**: `src/lib/server/rankScoring.ts` — `computeScores` (seven normalized
  components × config weights), `calculateGearPoints` (Temple clog + manual claims vs
  the gear table `rankScoring/gearScoring.json`), `calculateCAPoints` (WikiSync task ids
  vs `rankScoring/combatAchievements.json`, whole-tier rewards only),
  `determineProjectedRank` (thresholds → womRole). The seven components are gear, EHB,
  combat achievements, time-in-clan, collection log, total level, and **Volition TCG**
  (`tcg`) — owned card variants / obtainable, so a full set = 100% of that component. The
  default weights are gear 0.35 · ehb 0.25 · ca 0.10 · time 0.05 · clog 0.10 · level 0.10 ·
  tcg 0.05.
- **Volition TCG component**: `src/lib/server/tcgProgress.ts` — `getTcgProgress(userId)`
  returns `{ owned, total }` counted the SAME way the Collection tab does (`cardProfile.ts`):
  at the VARIANT level — each finish a card can roll (Holo / Reverse / Normal) is its own
  slot, and a secret rare is a single mystery slot until any finish is owned. The finish
  logic is shared via `src/lib/cards/finishVariants.ts` (`possibleFinishes`) so the rank
  count and the grid never diverge. Cards from **elemental** packs (event gifts, not freely
  obtainable) are excluded entirely. It's kept out of the pure scoring module (DB I/O) and
  folded in by the caller that has the member's site user id (`rankCheck.ts`, the rank-sim
  refresh, onboarding) before scoring; `fetchPlayerRankInputs` (RSN-keyed external data)
  can't read it and leaves it 0. The counts are cached on the member's `vs_rank_sim` row
  (`tcg_owned` / `tcg_total`) so the breakdown re-scores without re-reading `vs_user_cards`.
- **Config**: `src/lib/server/rankConfig.ts` — weights/caps/curves/thresholds live in the
  `bot_config` row `rank_scoring` (edited via `/admin/ranks/simulator`, 60s cache);
  `DEFAULT_RANK_CONFIG` is only the fallback. `sanitize()` normalizes the weights to sum 1
  and carries a one-time migration: a config saved before the TCG component existed (no
  `tcg` weight) has TCG's weight carved out of time-in-clan, matching the intended
  rebalance instead of diluting every component. Idempotent — rows that already carry a
  `tcg` weight skip it.
- **Progression curves (gear + EHB)**: gear and EHB are the two highest-weighted
  components but their caps sit near the top of the account ladder, so a linear
  normalization leaves most of the roster bunched at the bottom of both bars (flat
  mid-game). Two config knobs fix this without touching the distribution:
  - `caps.gear` — the gear points at which the gear bar maxes. `0` = `GEAR_SCORE_CAP` (the
    gear table's full sum); a value in `(0, 1]` is a **fraction** of that sum (default
    `0.95` → the bar maxes at 95% of the total gear points, and stays 95% when the point
    table is reshuffled); a value `> 1` is an absolute gear-point figure (e.g. `12000`).
    Lowering it lets a strong-but-not-BiS setup read near full. `effectiveGearCap(config)`
    resolves it; the gear grid + `GEAR_SCORE_CAP` invariant are unchanged.
  - `curves.gear` / `curves.ehb` — diminishing-returns exponents applied in `curveNorm`
    (`(raw/cap) ** exponent`). `1` = linear (default); `0.5` = sqrt, front-loading early
    progress so mid-game hours/gear move the score most. Clamped to `[0.2, 1]`.
  Defaults reproduce today's scoring exactly, so live ranks don't move until an admin sets
  them in `/admin/ranks/simulator`. Changing them raises everyone's raw composite, so **re-run
  "Suggest thresholds"** after — the curves control *how rewarding climbing feels*, the
  thresholds control *the distribution* (independent knobs). Recommended starting point
  for this roster: `caps.gear 12000` / `curves.gear 0.6`, `caps.ehb 1500` /
  `curves.ehb 0.5`.
- **Inputs**: `src/lib/server/rankData.ts` — `fetchPlayerRankInputs(rsn, roster?,
  manualGearNames?, accountType?)`: EHB/join-date/total-level from WiseOldMan, gear + clog
  slots from TempleOSRS, CAs from WikiSync. Availability flags (`templeAvailable`,
  `wikisyncAvailable`) mark degraded reads.
- **Group-ironman EHB**: `src/lib/server/rankScoring/ehb.ts` holds a verbatim port of Wise
  Old Man's **ironman** EHB rate table. For members the site knows are group ironman
  (`account_type` = `gim` / `gim_unranked`), we ignore WOM's `player.ehb` (which can be
  computed on MAIN rates for GIMs) and recompute EHB from their WOM boss KCs
  (`fetchPlayerBossKills`) on iron rates — `usesIronmanEhb` gates it, `computeIronmanEhb`
  does the sum. Applied at fetch time in BOTH scoring paths (`/me` checkRank passes the
  session user's `account_type`; the rank-sim refresh looks it up per RSN from `vs_users`).
  Regular iron/hcim/uim already get iron EHB from WOM, so they're excluded. On a WOM boss
  outage we fall back to WOM's EHB rather than zeroing the component.

## Signature ranks (prestige completion layer)

A separate prestige layer that sits ON TOP of the composite clan rank — not scored from the
weighted composite, but earned by **fully completing whole categories**. A category counts
as complete when its bar is maxed (`raw ≥ cap` — the same green "maxed" state the Rank tab
shows). Three tiers, over the seven scored categories:

- **Savant** — any 5 / 7 categories complete
- **Curator** — any 6 / 7
- **Paragon** — 7 / 7 (total completion)

- **Metadata + math**: `src/lib/rankSignature.ts` (client-safe) — `SIGNATURE_TIERS`
  (`required` counts, labels, badge paths, colours), `isCategoryComplete`,
  `completedCategoryCount`, `earnedSignatureTier`, `nextSignatureTier`. Badge art lives in
  `static/ranks/` like the other rank icons (`/ranks/Savant.webp` …); the UI falls back to a
  coloured chip if a file is missing, so a not-yet-supplied icon never breaks the page.
- **Where it's computed**: `buildRankBreakdown` (`meData.ts`) tags each component complete
  (`raw ≥ cap`), counts them, and returns `signature { completed, total, earnedKey,
  categories }`. `RankPanel.svelte` renders the "Signature ranks" panel (earned badge, an
  X / 7 tracker, the three tiers with unlock rules, and a per-category checklist) plus an
  earned chip beside the clan rank. Completion tracks the LIVE caps, so tuning a cap in the
  rank-sim changes what counts as "complete" automatically.
- **Home rank breakdown** (`homeData.ts` → `+page.svelte`): counts each member by the rank
  they DISPLAY (effective — prestige when they've opted in + earned, else composite), so the
  Savant/Curator/Paragon tiers appear as their own bars. Within every bar, members with no
  linked TempleOSRS log (`vs_rank_sim.temple_available` false / missing) are drawn as a
  lighter shade of the rank colour — they can't be fully scored, so separating them shows the
  real spread. `players` is read with `select('*')` so the signature columns are optional.
- **In-game display toggle** (`db/scripts/player_signature_rank.sql`): two columns on the
  shared `players` row, WRITTEN BY THE SITE and READ BY THE BOT's future `/sync`:
  `signature_rank` (the tier the member currently qualifies for, refreshed on each full
  rank check in `checkAndSaveRank` → `setPlayerSignatureRank`) and `prefer_signature_rank`
  (the member's toggle, set from the `/me` signature panel via the `setSignaturePref`
  action → `playerStats.setSignaturePref`). `players.rank` is deliberately left as the
  composite WOM role so the current rank displays + Discord role sync keep working; `/sync`
  combines the three to tell admins which in-game rank to set. The toggle is scoped to `/me`
  (passed to `RankPanel` as the `signatureControl` snippet); public `/u` profiles omit it.

## Where scoring runs

- **`/me` "Check my rank"** (`routes/me/+page.server.ts` `checkRank`): fetches live
  inputs (+ the member's approved gear claims), caches them in `vs_rank_sim`, and writes the
  rank to `players.rank` (the bot mirrors it to Discord) unless a stats source errored
  transiently (see the save-gate below). A saved climb returns `form.rankUp` → the confetti
  overlay.
- **Single-player core** (`src/lib/server/rankCheck.ts` `checkAndSaveRank`): the shared body
  of the above — fetch live inputs, cache the breakdown (reusing any case/underscore-variant
  `vs_rank_sim` row so a spelling mismatch never duplicates), and persist `players.rank`.
  `/me`'s `checkRank` (with its per-user cooldown + rank-up celebration) and the admin
  **"Re-check one player"** both call it, so the two paths score, cache, and save identically.
- **Save-gate: missing ≠ errored** (the key rule). `fetchPlayerRankInputs` now reports a
  `templeStatus`/`wikisyncStatus` of `'ok'` | `'missing'` | `'error'` (via `getJsonOutcome`,
  which reads the HTTP status: a 404 / empty body is `'missing'`, a network/timeout/429/5xx is
  `'error'`). On a source `'error'` `checkAndSaveRank` **bails before writing anything** —
  neither `players.rank` NOR the `vs_rank_sim` cache row is touched, so the member keeps their
  last-good rank *and* Temple flag. (The bail is above the cache upsert on purpose: a degraded
  pass zeros gear/clog/CA, and writing `gear_points=0` / `temple_available=false` next to a
  retained high rank is exactly what makes the home page shade a real Myth/TzTok member as
  "ranked without Temple" — an impossible combination, since gear is Temple-only. Skipping the
  cache too keeps the shading honest and the `/me` breakdown on last-good data.) A player
  Temple/WikiSync has simply never tracked comes back `'missing'`: their gear/clog/CA genuinely
  score 0, so the composite IS their correct rank on available data, and it's cached + saved.
  During a real outage every source errors → nothing saves → no mass demotion.
  `templeAvailable`/`wikisyncAvailable` stay `status === 'ok'` (they drive the breakdown display
  + the home non-Temple shading, which reads `vs_rank_sim.temple_available`).
- **Admin "Re-check rank" on `/u/[rsn]`** (`recheck` action): an admin viewing any member's
  profile gets a button (shown when `data.canRecheck`, i.e. `isAdmin`) that runs the same
  single-player live check for that member — resolved from `vs_users`, so it folds in their
  approved gear claims and writes the right `players.rank`. The page load re-runs afterward,
  so the rank panel reflects the fresh result. An on-demand refresh without sweeping the whole
  roster via `/admin/ranks/simulator`.
- **`/admin/ranks/simulator`**: bulk refresh into `vs_rank_sim` (batched, WOM-rate-limited),
  instant re-scoring while tuning, threshold suggestion, bulk apply to `players.rank`,
  and the live comparison vs in-game WOM roles. The refresh auto-chains one batch at a
  time over the whole WOM roster; **"Skip players who already have Temple data"** (on by
  default, `onlyMissing`) drops members whose cached row is already Temple-complete so a
  top-up only fetches new members / prior Temple outages — uncheck for a full re-fetch.
- **`/admin/ranks/mass-update`**: runs the full `checkAndSaveRank` (fetch → score → cache →
  write `players.rank` + `signature_rank`) over the WHOLE clan, one small batch at a time,
  auto-chaining until done. Unlike the simulator refresh (which only caches inputs), this also
  applies the result, so it's the one-click "bring everyone's live rank up to date." The
  population is every site member (`vs_users`) **unioned with every `players` roster member who
  never linked a site account** — matched by discord id then normalized RSN. The home rank
  breakdown counts the full `players` roster, so scoring only site users left roster-only
  members stranded on their old bot rank (and always shaded "no Temple", having no `vs_rank_sim`
  row); those members are now scored by RSN with a null user id (their claim + TCG reads no-op)
  and a null account type (WOM carries none, so main-rate EHB — a GIM's may read a touch high).
  Passes a cached WOM roster into each check so it isn't re-fetched per member. Reports `saved`
  vs `skipped` (members whose Temple/WikiSync **errored transiently** — re-run to catch them);
  members those sources have simply never tracked are saved on available data, not skipped.
- The three admin rank tools live under one hub, **`/admin/ranks`** (a `RanksTabs` bar):
  Gear Claims (the default tab) · Simulator · Mass Update. Each is its own route with its own
  load/actions; the bar just makes them read as one panel.
  The **live comparison** measures each member's projected rank against their current
  in-game rank (their WOM group role). Members whose WOM role doesn't map to a clan rank
  (staff/mod/special titles) are **included** with a baseline estimated from the clan's
  legacy EHB ladder (`ehbRank` / `EHB_RANK_THRESHOLDS` in `$lib/ranks`, mirroring the bot's
  `config/ranks.json` `ehbMin`), flagged `est`, so only no-Temple / not-cached members are
  left out. The comparison reads the member's WOM role from the cached
  **`vs_rank_sim.wom_role`** column (populated on refresh; SQL in
  `db/scripts/rank_sim_wom_role.sql`), so it needs **no live WOM call** — a WOM rate-limit no
  longer blocks it (the roster is fetched only for the roster-size / not-cached coverage
  counts, and the comparison degrades gracefully when it's unavailable).
- **Display**: `src/lib/server/meData.ts` `loadRankBreakdown` re-scores the cached row
  with the current config; `src/lib/profile/RankPanel.svelte` renders it (per-component
  ⓘ explainers; zero-score setup tips on /me via `showSetupTips`). The panel also shows
  the **next-rank badge** you're working toward and an **All clan ranks** modal (built
  client-side from `$lib/ranks` `RANK_ORDER` / `RANK_IMG`).

## Rank-up advisor ("How do I rank up?")

`src/lib/server/rankScoring/rankAdvice.ts` — `buildRankAdvice(inputs, config, overrides)`
turns a member's cached inputs into actionable guidance toward their **next** rank:

- Ranks every unearned gear entry **easiest-to-obtain first**, tagging each as **boss** or
  **non-boss** (`fromBoss` = any still-missing piece is a curated `itemEhb.json` drop).
  Boss/raid items get a real obtain-time + points/hour from the curated drop-rate math
  (`$lib/ehb` `bestEhbSource` + admin `vs_ehb_overrides` item pins). Non-boss items show no
  time — Temple's `itemEhc.json` `ehc` is used ONLY as an *easiness* ordering signal (a low
  value means a cheap, common pickup), never as a displayed number, because `ehc` is an
  item's marginal share of its category's completion, not a standalone grind (a Zenyte shard
  reads ~5 min). Cheap non-boss items (EHC ≤ `EASY_ENTRY_EHC`) sort into the easy band;
  rare/crafted items sort last.
- For every composite component it computes a realistic **potential** (reachable fill) and
  the composite gain that unlocks — gear (top targets' points), EHB (bossing those drops
  adds hours), collection log (trackable gear fills slots), CAs (`nextCaTier` in
  `rankScoring.ts` — the next whole-tier reward), total level (a +50 bump), and time
  (passive). Steps are ordered by composite gain.
- Estimates only: EHB assumes efficient play, and crafted/upgraded gear (Oathplate, …)
  has no obtain-time data (shown without a time).

Served lazily from **`src/routes/api/rank-advice/+server.ts`** (`memberEndpoint`, reads the
signed-in member's freshest `vs_rank_sim` row). The /me Rank tab fetches it only when the
member presses **"How do I rank up?"**, then tints each score bar with a per-component
overlay showing the reachable gain and renders the step-by-step plan + gear targets. `/u/[rsn]`
omits the button (no `adviceEndpoint` prop) but still shows the next-rank badge + all-ranks
modal.

## Manual gear claims (untrackable items)

Some gear-table items can't be proven by the Temple collection log — the obtain method
registers no log slot (e.g. Oathplate crafted from Oathplate shards), or the item is an
upgraded variant combined outside the log (Blood Torva, Radiant Oathplate). (The clan is
all-ironman, so "just buy it" is never the answer — these are earned in-game but invisible
to the log.) The claims channel covers them:

- **Member**: /me Rank tab → "Own rank gear the collection log can't see?" opens
  `src/lib/profile/GearClaimModal.svelte` (also reached from a gear tile's "Claim this
  item" shortcut, prefilled) — pick one of the **claimable** items (Oathplate helm/chest/
  legs, Radiant Oathplate, Blood/Sanguine Torva), drop/paste/attach proof screenshots,
  submit. The modal reuses the shared `ImageDropper` (drag · drop · paste) from the event
  submissions. One live claim per item (rejected claims may be resubmitted). An entry may
  carry an optional `claimNote` (gear table → `ClaimableGearItem.claimNote`) shown under the
  item picker when it's selected — the Oathplate pieces use it to ask for the member's
  Oathplate shard collection-log count as proof they crafted the piece rather than receiving
  the finished item from a group mate.
- **Admin**: `/admin/ranks/claims` — pending queue with proofs, approve/reject + note.
- **Effect**: APPROVED claims (`vs_rank_item_claims`, `db/scripts/rank_item_claims.sql`)
  merge into `calculateGearPoints` as owned items (count 1) at the next `/me` rank check
  and the next rank-sim refresh — nothing rewrites cached rows retroactively.
- **Module**: `src/lib/server/rankClaims.ts`. The claimable set is **only** the gear-table
  entries flagged `claimable: true` (currently Oathplate helm/chest/legs, Radiant Oathplate,
  Blood/Sanguine Torva). `claimableGearItems()` is the single gate for both the /me picker
  and the `submitGearClaim` validation, so no other item can be manually submitted. Proofs
  share the bingo bucket under a `rank-claims/` prefix.

### Tiers, sections, and display icons

Gear-table entries carry a `tier` (`mega` / `expression` / `end` / `middle` / `low` /
`side`; ordered + labelled in `meData.ts`). **Mega Rares** = Twisted Bow / Scythe /
Shadow; **Skill expression** = Infernal cape, Dizana's Quiver, Blood Torva, Radiant
Oathplate. An entry may set `icon` to override the displayed/linked item when the clog
check isn't what to show — DT2 rings (check the vestige, show the ring), combined weapons
(Bludgeon/Voidwaker/Noxious/Twinflame show the finished item), Corp/dragon
sigils+visages (show the shield), etc. `GearCatalogEntry.iconItem` drives display+wiki;
`checkItem` is the clog-tracked/claim-match name; they diverge when `icon` is set.

### All-or-nothing + in-progress state

Multi-part entries (armour sets, combined items, quantity checks) are **all-or-nothing**:
`calculateGearPoints` awards the full points only when EVERY check is met, and reports a
partially-owned entry as a `GearPartial` (0 points + the still-missing check items, cached
in `gear_detail.partials`). The gear grid renders three states — complete, **in progress**
(dashed amber, "in progress" ribbon), and missing. Points are never awarded until the
entry is finished. For any assembled entry (`GearCatalogEntry.components` / `assembled`),
the item modal shows the FULL component breakdown — every piece with an owned ✓ / needed
○ mark and a wiki link (e.g. clicking Voidwaker lists hilt, gem, blade). A slot with
OR-alternatives lists all accepted variants joined by "or" (e.g. the Ahrim/Blue Moon set
shows "Ahrim's helm or Blue moon helm" per slot) — the component carries every alternative
(`GearComponent.names`), not just the first.

An entry may carry a `note` (surfaced in the item modal) to explain a non-obvious scoring
assumption. The **Enhanced crystal weapon seed** is split into two independent entries —
**Bow of Faerdhinen** (`quantity: 1`) and **Blade of Saeldor** (`quantity: 2`) — so each
seed scores on its own: we assume the first seed becomes the bow and the second the blade,
and each note says so. (One seed → bow points; two seeds → bow + blade.)

The same split gives **Tormented synapse** and **Zenyte shard** incremental credit.
Instead of one `quantity: N` entry that pays nothing until all N are owned, each is a set
of independent `quantity: 1 … N` entries whose points sum to the original — so each
drop earns its share (Tormented synapse: 3 × 200 = 600; Zenyte shard: 4 × 200 = 800).
We don't map them to specific end products, so the notes just say each counts on its own.
This "split into per-count entries" trick is the general way to turn an all-or-nothing
quantity check into partial credit without changing the scoring engine.

The **Ahrim/Blue moon robes** use the same idea for a multi-slot set: instead of one
all-or-nothing entry needing helm + top + legs, it's three independent per-slot entries
(34 / 33 / 33 = 100, unchanged), each accepting either brand for that slot
(`["Ahrim's hood", "Blue moon helm"]`, …) — so each robe piece earns on its own.

Every gear-grid tile opens the shared `ItemInfoModal` (tier, points, status, tracking
source, wiki link). Entries flagged `claimable: true` are untrackable by the clog: their
tiles wear a "claim" ribbon, and on /me (where the panel gets an `onClaim` handler) the
modal carries a "Claim this item" shortcut that opens the claim form prefilled.
`GEAR_SCORE_CAP` must stay equal to the sum of all entry points — update it whenever
entries are added or repointed.

## Manual adjustments (the staff escape hatch)

Some members can't be scored correctly from tracked data, and no amount of code can tell
their case apart from someone who simply hasn't done the work.

**Editing happens IN PLACE on the member's profile** (`/u/[rsn]`), not in a separate form:
an admin opens the member and clicks the thing that's wrong — a score bar, the rank badge,
or a gear tile. The value being edited sits right next to the number it changes, which is
the whole point (there's no picker to select the wrong member with, and no item field to
mistype). `RankPanel` takes an `adminEdit` prop; it's null for everyone else, and that null
is what keeps the panel read-only for members. The actions live on `/u/[rsn]/+page.server.ts`
(`adjust` · `pinRank` · `clearAdjustments` · `grantItem` · `revokeGrant`) and each one
**re-scores the member immediately**, so the panel behind the editor shows the result.

**`/admin/ranks/adjustments` is the RECORD** — the clan-wide view of everything set by hand,
with a link through to each member's profile to change it. Its one remaining form covers the
only members a profile can't: clan-roster members with no site account (about half the
roster), who have no `/u` page to open. Overrides are keyed by RSN precisely so they're
reachable; items can't be granted to them at all (grants hang off `vs_users.id`), so a
gear-points adjustment is the substitute.

Both surfaces are admin-only, both require a reason, and both are automatically recorded in
`vs_audit_log` (every POST under `/admin/**` is — see `audit.ts`, which also humanizes these
actions; the profile actions are recorded because an admin form action anywhere is audited).

### 1. Scoring adjustments (`vs_rank_overrides`)

`src/lib/server/rankOverrides.ts`, schema in `db/scripts/rank_manual_adjustments.sql`. One
row per member, **keyed by lowercased RSN** — not by `vs_users.id` — because scoring runs by
RSN and the roster includes members with no site account at all (the mass update scores them
from WOM alone). `user_id` / `discord_id` are carried for display and linking only.

Ordered weakest-first, and that order is the guidance:

- **Input adjustments** feed the normal formula, so the caps, curves and thresholds still
  apply and the member keeps climbing on their own from the adjusted baseline:
  - `ca_tier_override` — treat the member as having banked every tier-completion reward up
    to that tier (`caPointsForTier` in `rankScoring.ts`, the same arithmetic
    `calculateCAPoints` does from a task list). **This is the group-ironman case**: GIMs hold
    the Grandmaster combat-achievement tier without completing every task, so the WikiSync
    task list understates their CA component. It only ever RAISES the component — a member
    whose task list already proves more keeps the more.
  - `gear_points_bonus` · `ehb_bonus` · `clog_bonus` · `months_bonus` — additive nudges to the
    raw inputs (may be negative, never take an input below 0). A `clog_bonus` on a member with
    no Temple log also seeds `clogAvailable`, which the component needs to score at all.
  - `total_level_override` — replaces the fetched total level outright.
- **`rank_override` is a HARD PIN**: the composite is still computed and cached (so the /me
  breakdown stays honest about the underlying numbers) but the rank the member is *given* is
  the pinned one. Blunt — reach for the input adjustments first. Edited from the pencil on the
  rank badge itself.

**Each editor owns exactly one field.** They post to `patchRankOverride`, which merges into
the existing row rather than upserting the whole thing — a full write from the EHB editor
would otherwise blank the CA tier an admin set a minute earlier, silently. When the merge
leaves nothing adjusted (every nudge back to zero, no tier, no pin) the row is **deleted**
rather than kept as a no-op, so the record lists live adjustments only. There's no editor for
the **Volition TCG** bar: that count comes from the site's own card tables, so it's always
exactly knowable and there is nothing an adjustment could legitimately correct.

**Where it applies.** The input adjustments land at FETCH time, exactly like approved gear
claims, so the ADJUSTED numbers are what gets cached in `vs_rank_sim` and every reader
downstream (the /me breakdown, the home rank spread, the simulator's recalc) reflects them
with no extra plumbing — `applyRankOverride(inputs, override)` in `checkAndSaveRank` and in
the rank-sim refresh. The pin is applied wherever a rank is WRITTEN or DISPLAYED, via
`resolveRank(computed, override)`: `checkAndSaveRank` (so /me, the admin re-check and the
mass update all honour it), the simulator's **bulk apply** (a bulk apply must never quietly
undo a staff decision) and its **comparison** (a pinned member's rank IS the pin, so they
don't read as a permanent mismatch), and `buildRankBreakdown` in `meData.ts`. The simulator's
distribution/threshold-suggestion views deliberately do NOT apply pins — those measure the
*formula's* spread. `RankPanel` says "this rank was set by staff" / "staff have adjusted this
player's scoring" so a rank the visible numbers don't produce never looks like a bug.

Nothing is rewritten retroactively — an adjustment reaches the member's rank on their next
check, so **the admin page runs one for them on save** (and on clear, and on grant/revoke).
A degraded re-check is reported as a warning; the adjustment itself is already stored.

### 2. Item grants (`vs_rank_item_claims`, `source = 'admin'`)

The same table as member gear claims, with two added columns (`source`, `quantity`). An admin
grants an item outright — written as an already-APPROVED row so it flows through the exact
same scoring path as a reviewed claim, tagged `source='admin'` so the two never blur together
(the member review queue filters to `source='member'`; grants are listed on the adjustments
page instead).

- **Granted from the tile itself.** An admin clicks the gear piece in the member's gear grid;
  the item modal that already shows its points and tracking source carries the grant control.
  So the item credited is by construction the item being looked at, and the modal shows what's
  already credited (staff grant vs approved claim) with a revoke.
- **The whole gear table, not the claimable subset.** `allGearItems()` vs
  `claimableGearItems()`. Members may still only submit `claimable: true` entries — this is
  for items that are trackable in principle but unprovable in this member's case. A claim the
  member submitted is NOT editable from the tile; it goes back through the review queue.
- **A count, because several entries are quantity checks.** The motivating case: a member who
  got four Zenyte shards before the in-game collection log existed. Zenyte Shard is four
  independent entries needing 1/2/3/4 shards, so a grant that could only say "owned" would
  credit one of the four. `grantGearItem` clamps to `maxUsefulQuantity(item)` — more than the
  largest quantity any entry asks for scores nothing extra.
- `calculateGearPoints` now takes `ManualGearItem[]` (`{ name, count }`) rather than names.
  A manual credit takes the HIGHER of the clog count and the granted count, never the sum:
  they describe the same items, so adding them would double-count. Two grants of one item
  collapse the same way (`mergeCounts`).
- Grants need a `vs_users` id, so a roster member with no site account can't receive one —
  the page says so and points at the gear-points adjustment instead.

**This is not a members-facing channel and must not become one.** Mass self-granting is
exactly what the claim queue's review step exists to prevent; these are exceptions the code
can't account for, tracked by hand.

## Keeping the gear/CA tables current

`gearScoring.json` and `combatAchievements.json` are the canonical hand-maintained
copies (the bot's originals were retired). New CAs auto-extend daily from the OSRS Wiki
(`caNames.ts`); new GEAR needs a hand edit — add the entry, and if it's untrackable,
mark it `claimable: true` so the claims channel accepts it (only `claimable: true`
entries are manually submittable).
