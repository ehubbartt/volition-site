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
- **Config**: `src/lib/server/rankConfig.ts` — weights/caps/thresholds live in the
  `bot_config` row `rank_scoring` (edited via `/admin/rank-sim`, 60s cache);
  `DEFAULT_RANK_CONFIG` is only the fallback.
- **Inputs**: `src/lib/server/rankData.ts` — `fetchPlayerRankInputs(rsn, roster?,
  manualGearNames?)`: EHB/join-date/total-level from WiseOldMan, gear + clog slots from
  TempleOSRS, CAs from WikiSync. Availability flags (`templeAvailable`,
  `wikisyncAvailable`) mark degraded reads.

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
  ⓘ explainers; zero-score setup tips on /me via `showSetupTips`).

## Manual gear claims (untrackable items)

Some gear-table items can't be proven by the Temple collection log — the obtain method
registers no log slot (e.g. Oathplate crafted from Oathplate shards), or the item is an
upgraded variant combined outside the log (Blood Torva, Radiant Oathplate). (The clan is
all-ironman, so "just buy it" is never the answer — these are earned in-game but invisible
to the log.) The claims channel covers them:

- **Member**: /me Rank tab → "Own rank gear the collection log can't see?" opens
  `src/lib/profile/GearClaimModal.svelte` (also reached from a gear tile's "Claim this
  item" shortcut, prefilled) — pick a gear-table item, drop/paste/attach proof
  screenshots, submit. The modal reuses the shared `ImageDropper` (drag · drop · paste)
  from the event submissions. One live claim per item (rejected claims may be resubmitted).
- **Admin**: `/admin/rank-claims` — pending queue with proofs, approve/reject + note.
- **Effect**: APPROVED claims (`vs_rank_item_claims`, `db/scripts/rank_item_claims.sql`)
  merge into `calculateGearPoints` as owned items (count 1) at the next `/me` rank check
  and the next rank-sim refresh — nothing rewrites cached rows retroactively.
- **Module**: `src/lib/server/rankClaims.ts` (claimable list is the flattened gear-table
  check names; proofs share the bingo bucket under a `rank-claims/` prefix).

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
the claims channel picks it up automatically (the claimable list derives from the
table).
