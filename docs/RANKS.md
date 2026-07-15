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

Some gear-table items can't be proven by the Temple collection log — tradeable pieces
bought on the GE, or upgraded variants combined outside the log (Blood Torva, Radiant
Oathplate). The claims channel covers them:

- **Member**: /me Rank tab → "Own rank gear the collection log can't see?" — pick a
  gear-table item, attach proof screenshots, submit. One live claim per item (rejected
  claims may be resubmitted).
- **Admin**: `/admin/rank-claims` — pending queue with proofs, approve/reject + note.
- **Effect**: APPROVED claims (`vs_rank_item_claims`, `db/scripts/rank_item_claims.sql`)
  merge into `calculateGearPoints` as owned items (count 1) at the next `/me` rank check
  and the next rank-sim refresh — nothing rewrites cached rows retroactively.
- **Module**: `src/lib/server/rankClaims.ts` (claimable list is the flattened gear-table
  check names; proofs share the bingo bucket under a `rank-claims/` prefix).

## Keeping the gear/CA tables current

`gearScoring.json` and `combatAchievements.json` are the canonical hand-maintained
copies (the bot's originals were retired). New CAs auto-extend daily from the OSRS Wiki
(`caNames.ts`); new GEAR needs a hand edit — add the entry, and if it's untrackable,
the claims channel picks it up automatically (the claimable list derives from the
table).
