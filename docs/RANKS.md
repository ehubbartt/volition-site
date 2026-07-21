# Ranks — composite scoring, checking, and manual gear claims

The clan rank is a weighted composite of six components, scored server-side from three
external sources plus one manual channel. This doc is the map; the code carries the
detail.

## Scoring pipeline

- **Pure math**: `src/lib/server/rankScoring.ts` — `computeScores` (six normalized
  components × config weights), `calculateGearPoints` (Temple clog + manual claims vs
  the gear table `rankScoring/gearScoring.json`), `calculateCAPoints` (WikiSync task ids
  vs `rankScoring/combatAchievements.json`, whole-tier rewards only),
  `determineProjectedRank` (thresholds → womRole).
- **Config**: `src/lib/server/rankConfig.ts` — weights/caps/curves/thresholds live in the
  `bot_config` row `rank_scoring` (edited via `/admin/rank-sim`, 60s cache);
  `DEFAULT_RANK_CONFIG` is only the fallback.
- **Progression curves (gear + EHB)**: gear and EHB are the two highest-weighted
  components but their caps sit near the top of the account ladder, so a linear
  normalization leaves most of the roster bunched at the bottom of both bars (flat
  mid-game). Two config knobs fix this without touching the distribution:
  - `caps.gear` — the gear points at which the gear bar maxes. `0` (default) =
    `GEAR_SCORE_CAP` (the gear table's full sum, today's behaviour); a lower value (e.g.
    `12000`) lets a strong-but-not-BiS setup read near full. `effectiveGearCap(config)`
    resolves it; the gear grid + `GEAR_SCORE_CAP` invariant are unchanged.
  - `curves.gear` / `curves.ehb` — diminishing-returns exponents applied in `curveNorm`
    (`(raw/cap) ** exponent`). `1` = linear (default); `0.5` = sqrt, front-loading early
    progress so mid-game hours/gear move the score most. Clamped to `[0.2, 1]`.
  Defaults reproduce today's scoring exactly, so live ranks don't move until an admin sets
  them in `/admin/rank-sim`. Changing them raises everyone's raw composite, so **re-run
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

## Where scoring runs

- **`/me` "Check my rank"** (`routes/me/+page.server.ts` `checkRank`): fetches live
  inputs (+ the member's approved gear claims), caches them in `vs_rank_sim`, and — only
  when BOTH Temple and WikiSync responded — writes the rank to `players.rank` (the bot
  mirrors it to Discord). A saved climb returns `form.rankUp` → the confetti overlay.
- **`/admin/rank-sim`**: bulk refresh into `vs_rank_sim` (batched, WOM-rate-limited),
  instant re-scoring while tuning, threshold suggestion, bulk apply to `players.rank`,
  and the live comparison vs in-game WOM roles.
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
- **Admin**: `/admin/rank-claims` — pending queue with proofs, approve/reject + note.
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

## Keeping the gear/CA tables current

`gearScoring.json` and `combatAchievements.json` are the canonical hand-maintained
copies (the bot's originals were retired). New CAs auto-extend daily from the OSRS Wiki
(`caNames.ts`); new GEAR needs a hand edit — add the entry, and if it's untrackable,
mark it `claimable: true` so the claims channel accepts it (only `claimable: true`
entries are manually submittable).
