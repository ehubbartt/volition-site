# Volition Site 2.0 — Code Review & Improvement Plan

A full review of the `voli-site-2.0` branch (styling + events/dink + rank merges) covering
**component reuse**, **theming consistency**, **server/data architecture**, the **rank
scoring** system, and the **event-builder / Dink auto-tracking** pipeline.

Nothing in this document has been applied yet. Each item explains **what** it is, **why** it
matters, the **risk** of changing it, and a concrete **recommendation**, so you can pick what
to take on. Items are grouped by type and ordered by value within each group.

**Legend** — Severity: 🔴 correctness bug · 🟠 architecture · 🟡 cleanup/DRY · 🔵 theming.
Risk = chance a change introduces a regression. Effort = rough size.

---

## 0. Recommended order

If you want a single suggested path, do them in this order — each block is independent and
verifiable with `npm run check`:

1. **Safe correctness fixes** (§1) — small, self-contained, fix real user-visible money/rank bugs.
2. **Shared component extractions** (§2) — the bulk of the "are components reused?" ask.
3. **Theming consolidation** (§3) — mechanical, low risk, makes the new pages match.
4. **Server/data consolidation** (§4) — larger refactors, do when you have a quiet moment.
5. **Dink pipeline** (§5) — needs schema decisions; review before touching production.

---

## 1. Correctness bugs that are safe to fix now

These are real, user-visible, and each fix is self-contained (no schema changes).

### 1.1 🔴 `grantPlayerVp` has no optimistic lock — concurrent VP refunds lose points
`src/lib/server/playerStats.ts:103-114`

**What:** `grantGold` (234-255) does a 5-attempt optimistic-lock retry (`.eq('points', prev)`).
`grantPlayerVp` does a plain read-then-`update({ points: p.points + amount })` with no guard.

**Why it matters:** this is the **refund path** when a pack open fails. If two refunds (or a
refund racing the bot's own points write) land together, one increment is silently lost and the
member is permanently down VP. Money-losing and invisible.

**Recommendation:** apply the same optimistic-increment-with-retry loop `grantGold` uses.
**Risk:** low. **Effort:** small.

### 1.2 🔴 `convertWalletToGold` can settle items but fail to credit GP — no rollback
`src/lib/server/playerStats.ts:285-308`

**What:** it flips `wallet_items.paid_out = true` first, then calls `grantGold`. If `grantGold`
returns `null` (player row vanished, or all optimistic retries lose), the items are already
marked paid-out but the GP was never credited. Only a `console.error` is emitted.

**Why it matters:** the member permanently loses the value of those items — they can no longer be
claimed in-game *and* were never converted to balance. This is exactly the money-losing event
`postOpsAlert` exists for, yet it isn't called.

**Recommendation:** credit GP first then flip items, **or** on `grantGold` failure re-flip the
just-settled rows back to `paid_out = false`; and `postOpsAlert` on failure.
**Risk:** low–medium (touches a money path — test the happy path). **Effort:** small.

### 1.3 🔴 `checkRank` persists a wrongly-low rank on a transient API failure
`src/lib/server/rankData.ts:18-30,86-92` · `src/routes/me/+page.server.ts:206-254`

**What:** every external fetch (`getJson`) returns `null` on *any* failure, and the scoring layer
degrades a missing source to a component score of `0`. A transient WOM/Temple **429 or timeout**
is therefore indistinguishable from "this player genuinely has no data," and `checkRank` then
writes that degraded composite to `players.rank`.

**Why it matters:** the bot mirrors `players.rank` to the member's Discord role. A member who
briefly hits a rate-limit can get *demoted* on Discord off a bad read. The UI already surfaces
`templeAvailable`/`wikisyncAvailable` flags, so we know when a source failed — we just still write.

**Recommendation:** when a *critical* source is unavailable, skip the `setPlayerRank` write (still
show the computed breakdown, but don't persist). **Risk:** low. **Effort:** small.

### 1.4 🔴 `dinkDrops.resolveUserId` does an unescaped RSN match
`src/lib/server/dinkDrops.ts:49-52` (and the collect-N query at `:356`)

**What:** `users.ts:17-19` has a careful `rsnExactPattern()` that normalizes `_`→space and escapes
LIKE metacharacters (`% _ \`). `resolveUserId` instead does a bare `.ilike('rsn', rsn)`.

**Why it matters:** an RSN containing `_` or `%` matches the wrong row (or several), so a drop gets
credited to the wrong member or none. Same bug recurs in several `playerStats.ts` `ilike` lookups.

**Recommendation:** export `rsnExactPattern` from `users.ts` (or a shared `rsn` server util) and use
it for **every** `ilike('rsn', …)`. **Risk:** low. **Effort:** small. (Pairs naturally with §4.2.)

### 1.5 🟡 `simulateDinkDrop` `drop_key` can collide
`src/lib/server/dinkDrops.ts:168` — `test-...-${Date.now()}` collides if two simulations fire in the
same millisecond; if `drop_key` is unique-constrained the second insert errors. Add a random suffix.
**Risk:** none. **Effort:** trivial.

---

## 2. Component reuse — the "are components properly reused?" ask

The biggest theme: several presentational patterns are hand-written many times with slightly
different class vocabularies, which is why new pages drift visually. Extracting them is low-risk
(presentational) and directly answers the review's purpose. Ordered by value/risk.

### 2.1 🟡 `OsrsCounter.svelte` — the engraved VP/wallet readout
Duplicated markup: `gamba/+page.svelte:656-665`, `me/+page.svelte:93-96` & `402-405`.
Bespoke divergent clone: `u/[rsn]/+page.svelte:51-54` + its own `.vp` pill CSS at `236-256`
(rounded, no stone texture, **no `osrsTier()` color tiering**) — so the public profile looks
different from `/me`.

**Why:** one source of truth for the headline numbers; `/u/[rsn]` automatically gains the OSRS
value colors. **Proposed API:**
```svelte
<OsrsCounter value={vp} label="VP" title="Volition Points" />        <!-- number -->
<OsrsCounter value={gp} label="Wallet" format="gp" />                <!-- formatGP + osrsTier -->
```
**Risk:** low (class already in `app.css`). **Effort:** small.

### 2.2 🟡 `StatusPill.svelte` — pending/approved/rejected badge
`.status-pill` + the three color rules are **byte-for-byte identical** in
`lib/events/EventTaskCard.svelte:274-299` and `lib/tasks/WeeklyTaskCard.svelte:366-389`, with the
`status → label` ternary re-derived in `admin/submissions`, `admin/bingo/.../[userId]`, and
`bingo/SubmitModal.svelte`.

**Proposed API:** `<StatusPill status={'pending'|'approved'|'rejected'} />` (maps to label + colors).
**Risk:** low. **Effort:** small.

### 2.3 🟡 `StatCard.svelte` + `.stat-grid` — the "big number + label" card
Reimplemented ~8 ways with three different class vocabularies (`.stat/.stat-value`,
`.stat/.num/.lbl`, `.ms/.ms-num/.ms-lbl`): `+page.svelte:267-280`, `admin/wallets:66-87`,
`admin/submissions:204-216`, `admin/crate-sim:177-255`, `u/[rsn]:118-162`, `me` (`.ms…`), plus
`admin/pack-stats`, `admin/overview`, `admin/stats`.

**Why:** highest dedup volume of any finding; presentational so low risk.
**Proposed API:** `<StatCard value={n} label="…" accent? title? />` + a `.stat-grid` utility in
`app.css`. **Risk:** low. **Effort:** medium (many call sites).

### 2.4 🟡 Shared tab-bar styles
Five admin tab components (`StatsTabs`, `CardsTabs`, `DatabaseTabs`, `EventsTasksTabs`,
`ModerationTabs`) each re-declare an **identical** `.tabs/.tab/.tab.active` block; the client
button-tabs in `me/+page.svelte:105-121` and `u/[rsn]:61-72` duplicate another identical set
(`321-361`).

**Recommendation:** promote `.tabs/.tab` into `app.css` (or a `TabBar.svelte`); each admin
component shrinks to just its `TABS` array. **Risk:** very low. **Effort:** small.

### 2.5 🟡 `RankBadge.svelte` — image-or-color-dot + colored label
Written as real markup twice (`+page.svelte:246-255` snippet, `me/+page.svelte:181-194`) and
re-implemented as colored spans in `admin/stats:77-79` and `admin/rank-sim` (`139,168,211,245`).
The rank *helpers* (`$lib/ranks`) are correctly reused — it's the badge markup that's duplicated.
**Proposed API:** `<RankBadge rank={r} showLabel? size? />`. **Risk:** low. **Effort:** small.

### 2.6 🟡 `ItemIcon.svelte` + adopt in wallet lists
The full hotlink incantation (URL + `referrerpolicy="no-referrer"` + `onerror` hide) is spelled out
only at `me/+page.svelte:251-258`; `admin/wallets:184` and `u/[rsn]:172-176` render **bare item
names**. **Proposed API:** `<ItemIcon item={name} size? />` wrapping `itemIconUrl()` with the
fallback baked in; adopt in both wallet lists (and combine with §2.7). **Risk:** low. **Effort:** small.

### 2.7 🟡 `WalletList.svelte`
`/u/[rsn]` and `/me` both compute `wallet.reduce((s,w)=>s+w.quantity,0)` and render the same
name + `×qty` list — the public profile is a read-only subset of `/me`. Extract a `WalletList`
used by both; pairs with §2.6 so both finally show icons. **Risk:** low. **Effort:** small.

### 2.8 🟡 Display date helpers in `$lib/datetime`
`ago()` is copy-pasted verbatim in `admin/wallets:18-23` and `admin/pack-stats:17-21`; bare
`new Date(iso).toLocaleString()` is open-coded ~15× (`admin/tasks`, `admin/submissions`, the bingo
review/user pages, `EventTaskCard`, `WeeklyTaskCard`, several board modals…). `$lib/datetime` exists
but only holds form-submit helpers.

**Recommendation:** add `formatDate(iso, opts?)` and `formatDateTime(iso)` (return `—` on
null/NaN); replace the inline calls and delete the two `ago()` copies. **Risk:** low. **Effort:** medium (broad but mechanical).

### 2.9 🟡 `formatPct(n, total?)` helper
`pct()` is copy-pasted with **two different signatures** (one takes a 0–1 fraction:
`gamba:572`, `crate-sim:21-23`; one takes n+total: `pack-stats:23-26`), plus inline
`(count/max)*100` in `admin/stats`, `event/[slug]`, `admin/cards`, `admin/rank-sim`. The mismatched
signatures are a latent bug. Add one `formatPct` to `$lib/gp` (or new `$lib/format`).
**Risk:** low. **Effort:** small.

### 2.10 🟠 Adopt `ConfirmDialog` for destructive `confirm()` calls
`lib/ConfirmDialog.svelte` is on-theme and busy-aware but used in only 3 files; **8** destructive
actions still use the unstyled native `confirm()` (`admin/wallets:165` "zero balance",
`admin/events`, `admin/submissions`, `admin/cards`, `admin/tables/[table]`, `admin/inventory`,
`admin/events/[slug]`, `WeeklyTaskCard`). Adoption gap, not a new component.
**Risk:** low but per-site wiring (state + `onconfirm`); do highest-traffic pages first.
**Effort:** medium.

### 2.11 🟠 `ModalShell.svelte` — shared modal scaffold *(do last)*
The 7 board/bingo modals (`BoardAckModal` + 5 siblings, `bingo/SubmitModal`) each re-hand-roll the
`position:fixed; inset:0` backdrop, centered container, Escape + backdrop-click + scroll-lock.
A headless `ModalShell` would own that; each modal keeps only its body. **Higher value but higher
risk** — each modal has bespoke sizing/animation, so this is a careful refactor, not mechanical.
**Effort:** large.

---

## 3. Theming consistency

The global layout wraps every page in `.page` and `app.css` sprite-frames `.page :is(.card,.panel,.stat)`
with `!important`, so most panels get themed for free. The visible inconsistencies are bespoke
sub-elements, value readouts, and duplicated literals.

### 3.1 🔵 New pages render flat instead of sprite-framed
Flat `linear-gradient(...) + 1px solid` cards (the gradient is dead weight under `.page`, and any
non-`.card` box stays flat): `dink-check/+page.svelte:174-178` (`.card`) and **`:157-162` (`.status`
— not a `.card`, so it never gets the frame; this is the most visibly "off" element)**;
`admin/dink-test:155-156`; `admin/events/[slug]/builder:208-210`; `admin/dink-drops:95-96` (`.drop`);
`admin/rank-sim:332-338` (flat `--surface-alt`).

**Recommendation:** drop the redundant `background/border` from these `.card`s and give standalone
framed boxes like `dink-check`'s `.status` a themed panel class. **Risk:** low. **Effort:** small.

### 3.2 🔵 34 `'rsbold' / 'rssmall'` font literals instead of `var(--font-heading/-body)`
Worst offenders: `admin/cards` (6: lines 1280,1369,1460,1581,1728,1941), `me` (7: 636,792,927,938,
1004,1065,1094), `events/[slug]` (4), `admin/crate-sim` & `u/[rsn]` (2 each), singletons in
`rank-sim:396`, `admin/events:712`, `admin/stats:223`, `admin/pack-sim:283`, plus `gamba`/`PackOpener`
(double-quoted). Pure mechanical replace. **Risk:** none. **Effort:** small.

### 3.3 🔵 Squared-pill convention not applied everywhere
Status chips still at `border-radius: 999px`: `admin/admins:288-296` (`.pill` role tag),
`u/[rsn]:243` (`.vp-stat`, also §2.1), and chip/badge elements in `gamba` (1633,1721,2146) and
`PackOpener` (2300,2323,2495). Also the shared `.osrs-badge` in `app.css:483` is **itself still
999px** — if the squared convention is canonical, update it there too. **Leave round:** all the
`.bar-track/.bar-fill/.comp-bar/.rank-dot/.dot` (progress bars and dots). **Risk:** low. **Effort:** small.

### 3.4 🔵 Hardcoded `--accent` / panel hexes
`#ff981f` (=`--accent`) literal 6× in the high-traffic `+layout.svelte` (96,133,138,153,179,228) and
`admin/audit:424`. Panel hexes `#4d4030` (the stone fill — not yet a token) duplicated in
`events:220`, `gamba:1272,1805`, `admin/+page:133`, `me:494`; `#4d4336` (=`--border`) and `#3a3024`
(=`--surface`) used as backgrounds in a few places. **Recommendation:** use the existing tokens, and
promote `#4d4030` to a `--stone-fill` token so panel color lives in one place. (SVG/canvas colors in
`BoardMap`/`BoardFireworks` are a legitimate exception.) **Risk:** low. **Effort:** small.

### 3.5 🟡 Extract `.osrs-bar` progress-bar utility
The same `.bar-track` + `.bar-fill` block (height, `--surface-alt`, `1px solid --border`, rounded,
`overflow:hidden`) is re-declared in ≥7 places (`+page:1141`, `tasks:216`, `event/[slug]:154`,
`me:977`, `admin/stats:326`, `admin/pack-stats:261`, `WeeklyTaskCard`). Extract one `.osrs-bar /
.osrs-bar-fill` pair into `app.css`. Highest dedup value among the theming items. **Risk:** low. **Effort:** small.

### 3.6 🟠 Re-implemented buttons instead of the themed base `button`
`me/+page.svelte:931-939` (`.check-btn`) and `admin/rank-sim:377-397` (`.btn/.btn.primary`)
hand-roll button styling instead of the base OSRS `button` (which already has the bronze
`button.png` border-image), so they render flat next to the bronze buttons. Use real `<button>` /
map `.btn` to the base. **Risk:** low. **Effort:** small.

---

## 4. Server / data architecture

The layer is well-commented and the core patterns (single lazy Supabase client, pagination helpers
for the 1000-row cap, optimistic-lock money writes, fail-open reads, the audit hook) are sound.
These are consolidation opportunities, ordered by value.

### 4.1 🟠 No shared timeout-bearing fetch helper
`rankData.ts:18-30` has a proper `getJson()` with an `AbortController` 15s timeout. The other four
external callers have **none**: `wom.ts:28` (hung WOM blocks the Skill-or-Kill page load
indefinitely — Node `fetch` has no default timeout), and the Discord POSTs in `botBridge.ts:39,71`,
`dropsFeed.ts`, `opsAlert.ts:49`. `botBridge.sendBotMessage` is **awaited inside the gamba open
action**, so a stalled Discord egress hangs that request.

**Recommendation:** extract `getJson`'s abort pattern into a shared `serverFetch(url, opts,
timeoutMs)` (in `db.ts` or a new `http.ts`) and route all four through it; also consolidates the
duplicated `UA`/headers (`wom.ts:7`, `rankData.ts:15`). **Risk:** low–medium. **Effort:** medium.

### 4.2 🟠 `players` locate/deduct logic duplicated ~6×
`playerStats.ts` reimplements "find by `discord_id` else `ilike(rsn)`" in `getPlayerVp`,
`locatePlayer`, `getPlayerRank`, `setPlayerRank`, `getPlayerGold`/`locatePlayerGold`,
`getLastLootDate`/`claimFreeLootDay` (25 `.from('players')` calls in one file); `spendPlayerVp`
and `spendGold` (81-100 vs 210-228) are identical except the column name. **Recommendation:** one
`locatePlayer(discordId, rsn, columns)` + one generic `optimisticDeduct(column, …)`. This also fixes
§1.1 and §1.4 in one place. **Risk:** medium (central money code — verify carefully). **Effort:** medium.

### 4.3 🟡 Make `fetchAllFiltered<T>` generic
`db.ts:32` `selectAll<T>` is generic but `db.ts:55` `fetchAllFiltered` returns `{ data: unknown[] }`,
forcing ~15 callers to cast. Making it generic mirrors `selectAll` and removes a cast at every call
site — single highest-leverage type-safety cleanup. **Risk:** low. **Effort:** small.

### 4.4 🟡 Unify the two cache implementations
`adminRoles.ts` (TTL + `inflight` de-dupe + keep-stale-on-error) and `rankConfig.ts:67-101`
(TTL + keep-last-good but **no `inflight` guard**, so concurrent first-loads each hit the DB) solve
the same problem two ways. Extract a small `staleWhileRevalidate`/`singleflight` helper. (The
`dinkDrops` 20s throttle is a *different* concept — leave it, just document it.) **Risk:** low. **Effort:** small.

### 4.5 🟡 hooks.server.ts micro-fragilities
`hooks.server.ts:49-97`: `getBan` runs a DB query on **every** authenticated request including assets
that slip through with a cookie — move the path short-circuit (72-76) *before* the query. And the
audit `captureBeforeState` (90-92) issues a synchronous DB read in the mutation's request path; it's
best-effort by intent but not actually off the critical path (a slow read adds latency to the user's
write). Middleware *ordering* (health → canonical → session → roles → ban → audit) is otherwise
correct. **Risk:** low–medium. **Effort:** small.

### 4.6 🔵/🟠 Type-safety & error-contract notes *(documentation-level)*
- `auth.ts:67` `as unknown as SessionUser` double-cast masks a real array-vs-object embed shape — a
  join change wouldn't be caught. Worth typing the Supabase client (`supabase gen types`).
- Error-handling conventions are mixed four ways (throw / return null / `{ok,error}` / swallow+log).
  Each is individually defensible, but `dinkTokens.ts` **throws** while its read siblings return
  `null`, so a mint failure on `/dink` surfaces as a 500 instead of a graceful message. Either
  standardize token ops to `{ok,error}` or document the "reads fail-open, writes return results,
  integrations swallow" rule in `ARCHITECTURE.md`.
- 🟠 **Security posture to document:** `db.ts:10` uses the **anon** key for *all* writes (players,
  audit log, the generic table editor). All authorization is therefore enforced in app code
  (`isAdmin`/`isSuperAdmin`), not the DB/RLS. This is deliberate (see `playerStats.ts:48`) but the
  generic table editor on the anon key is the highest-blast-radius surface — worth an explicit note
  in `ARCHITECTURE.md`, and a candidate for a service-role split later.

---

## 5. Rank scoring system

Well-architected, carefully-commented port. The math was spot-checked and is internally consistent
(gear cap 25450 = sum of all gear points; CA `maxPoints` 980 = sum of tier rewards; thresholds match
cumulative wiki points). §1.3 above is the one real bug. The rest:

### 5.1 🟠 Weights aren't validated to sum to 1, but thresholds assume they are
`rankScoring.ts:215-216`, `rankConfig.ts:72-82`, `rank-sim/+page.svelte:112-114`

**What:** `composite = Σ(normalized·weight)`. If an admin saves weights summing to e.g. 1.3, every
composite scales up and the saved thresholds (calibrated for sum=1) become meaningless — players
jump ranks. `sanitize()` repairs structure but doesn't validate the weight sum; the UI only shows a
soft warning, and `saveRankConfig` persists the out-of-spec config that then drives live
`players.rank` writes. **Recommendation:** normalize weights in `sanitize()` **or** reject a save
when `|Σw − 1| > ε`. **Risk:** low. **Effort:** small.

### 5.2 🟠 Reference data duplicated across repos with the source-of-truth deleted
`rankScoring/*.json` (`gearScoring.json`, `combatAchievements.json`) and `DEFAULT_RANK_CONFIG` are
copied from the bot. The bot's `simulateRanks.js` that they were ported from **no longer exists**, so
the cited source of truth is gone and nothing asserts the two repos still agree — drift will silently
diverge ranks between the site's computation and the bot's Discord roles. The live *config* is
correctly shared via `bot_config.rank_scoring`; it's the **reference JSON** that's now orphaned.
**Recommendation:** mark `DEFAULT_RANK_CONFIG` as fallback-only in a comment, and add a checked-in
note (or a hash check) declaring these JSON files canonical. **Risk:** none (docs). **Effort:** small.

### 5.3 🟡 Smaller items
- `clogAvailable` is fetched, cached, and passed everywhere but **never affects the score**
  (`rankScoring.ts:206-209`) — the clog component is `clogFinished / caps.clog`. Either it should be
  `clogFinished / clogAvailable` (latent bug — verify against bot intent) or drop the field.
- `apply` does N sequential `setPlayerRank` calls (3 round-trips each) with no batching
  (`rank-sim/+page.server.ts:351-368`) — fine for a small clan, slow/timeout-risky for a large one;
  consider a bulk upsert.
- Export `ranks.ts`'s private `normalize()` instead of the open-coded
  `RANK_ORDER.includes(x.toLowerCase())` in `buildSummary` and `rankConfig.sanitize`.
- Stale doc comment at `rankConfig.ts:43` references the removed `seedRankConfig.mjs` (harmless).

---

## 6. Event-builder / Dink auto-tracking — **review before touching**

This pipeline has the most serious issues, and the top one may mean **auto-tracking currently
credits nothing in production**. Several fixes need a schema check or a new migration, which is why
they're broken out here for your decision rather than applied.

### 6.1 🔴 Auto-credit insert likely violates a `NOT NULL` constraint — silently
`src/lib/server/dinkDrops.ts:377-388` vs `src/routes/bingo/[slug]/+page.server.ts:379-387`

**What:** the auto-credit insert into `vs_bingo_completions` writes only the array columns
(`proof_urls: []`, `proof_paths: []`). The **manual** submit path writes both the arrays **and** the
legacy scalars `proof_url: urls[0]` / `proof_path: paths[0]`. Those singular columns predate the
arrays and are very plausibly `NOT NULL`.

**Why it matters:** if they are non-null, **every** auto-credit insert fails its constraint,
`insErr` is truthy, the drop is left unprocessed (389-391), and `maybeProcessDinkDrops` retries it
forever on every board load. Auto-tracking would credit nothing in prod — while the dink-test
"simulate" might pass against a schema where they're nullable, hiding it.

**How to verify (no guessing):** run in Supabase —
```sql
select column_name, is_nullable, column_default
from information_schema.columns
where table_name = 'vs_bingo_completions'
  and column_name in ('proof_url','proof_path','proof_urls','proof_paths');
```
**Recommendation:** if either scalar is `NOT NULL`, mirror the manual path's column set in the
auto-credit insert (e.g. `proof_url: '', proof_path: ''`). Either way, **stop swallowing `insErr`**
(see §6.4). **Risk of fix:** low (makes the insert match the proven-working manual path).

### 6.2 🔴 Collect-N progress isn't scoped to a tile — pools across tiles
`src/lib/server/dinkDrops.ts:350-374`

**What:** the comment claims partials are scoped per tile, but the `sameItem` test (363-367) matches
only on `item_id`/`item_name`, and the prior-partials query (352-357) filters only by
`event_id + rsn + outcome='partial'` — **not** by tile. A drop row carries no tile association.

**Why it matters:** if two tiles in one event both track e.g. "Bones ×5," a player's Bones drops are
summed into a single pool and can wrongly satisfy or short-change both tiles.

**Recommendation:** attribute each partial drop to the matched `tile_id` (store it on the drop or a
per-tile progress table) and filter the sum by tile. **Needs a small schema add** (a `tile_id` on the
drop/progress). **Risk:** medium; needs schema. *(Documented, not applied.)*

### 6.3 🔴 Collect-N partials are never consumed — revert/re-track double-counts
`src/lib/server/dinkDrops.ts:350-374`, `190-231`

**What:** the sum includes **all** historical `outcome='partial'` rows every time. After a tile
credits, those partials stay `'partial'` forever. So: player reaches 4/5 → gets the 5th → credited;
admin reverts (deletes the completion, marks only the crediting drop `'reverted'`) — the 4 partials
remain; a single new drop now sums 4 + 1 = 5 and **re-credits with one drop**. `reprocessDinkDrop`
has the same class of issue.

**Recommendation:** when a tile credits, mark the consumed partials terminal (e.g. `'consumed'`),
and reset them on revert. Pairs with §6.2 (both need tile attribution). **Risk:** medium; needs
schema. *(Documented, not applied.)*

### 6.4 🟠 Silent error swallowing hides §6.1 (and risks a duplicate credit)
`dinkDrops.ts:389-392` drops `insErr` with no log; `:333` swallows the existing-completion check
error (a transient error there makes `existing` falsy → risk of a **duplicate** credit); `:222`
(revert) and `eventStructure.ts:226,232,236` (`syncEventGrid`) also discard errors. **Recommendation:**
log `insErr` + the duplicate-check error with the drop id; after N failed attempts mark a drop
`outcome='error'` (dead-letter) so a poisoned row stops retrying forever. **Risk:** low (logging).
**Effort:** small. *(The logging half is safe to apply now; the dead-letter needs a value convention.)*

### 6.5 🟠 No DB guarantee of one credit per (event, user, tile) — races double-credit
`dinkDrops.ts:333` (existence check) + `:377` (insert) aren't atomic, and the throttle/inflight guards
(`:430-442`) are per-instance in-memory — on Fly.io with >1 machine each instance polls independently.
**Recommendation:** add a unique partial index and treat a unique-violation on insert as `'duplicate'`:
```sql
create unique index if not exists vs_bingo_completions_one_approved
  on vs_bingo_completions (event_id, user_id, tile_id)
  where status = 'approved';
```
This makes idempotency correct regardless of races/instances; the cron endpoint becomes the single
runner and poll-on-read a pure backstop. **Risk:** the index creation will **fail if duplicate
approved rows already exist** — de-dupe first. **Needs a migration you run.** *(SQL provided; not applied.)*

### 6.6 🟠 `cloneTemplateToEvent` isn't transactional — a failed re-clone wipes the board
`eventStructure.ts:174-198`: updates `structure`, **deletes all tiles**, then inserts new ones. If
the insert fails, the event is left with the new `structure` and **zero tiles**. `createFromTemplate`
rolls back the whole event, but `pickTemplate` on an **existing** event
(`builder/+page.server.ts:89`) does **not** — a failed re-clone destroys the existing board.
**Recommendation:** wrap clone in a DB function/RPC, or snapshot-and-restore on failure.
**Risk:** medium. **Effort:** medium.

### 6.7 🟠 Three copies of "is this tile open at time T"
`tileIsSubmittable` (`bingo/[slug]/+page.server.ts:298-307`), the consumer gate
(`dinkDrops.ts:307-322`), and `evaluateDinkDrop` (`dinkDrops.ts:124-135`) each re-implement
load-board → find tile → `getBingoState` → `getTileStatus==='open'`, and must stay in sync (manual
path uses `new Date()`, consumer uses `drop.received_at`). Extract one `isTileOpenAt(event, tileId,
at)` helper. **Risk:** low–medium. **Effort:** small.

### 6.8 🟠 Simulator can post to the public Discord feed
`dinkDrops.ts:158-185,397`: the admin **Simulate** action runs the real consumer; feed posts are only
suppressed by event status (`open`) and a slug allow-list. Simulating against an arbitrary *open*
event (the UI warns but doesn't enforce) posts a real credit announcement to the public webhook.
**Recommendation:** thread a `suppressFeed`/`isSimulation` flag through `simulateDinkDrop →
processDinkDrops`, or force a non-open preview event. **Risk:** low. **Effort:** small.

### 6.9 🟡 Smaller dink items
- `revertDinkCredit` matches auto-credits by `review_note LIKE 'Auto-tracked via Dink%'`
  (`:220`) — fragile string coupling; a dedicated `source='dink'` column would be robust (schema add).
- Builder mutations don't validate `tier ∈ structure.tiers.key` (`eventStructure.ts:251-313`,
  `builder/+page.server.ts:152`) — a malformed `tier` produces orphan tiles that won't render. All
  admin-gated, so low severity.
- `eventStructure.ts:101` redefines `DEFAULT_TILE_DETAILS` that already lives in `bingoTiles.ts:90`
  — import the one constant.
- `/api/dink/process` secret compare is non-constant-time (`api/dink/process/+server.ts:12-18`) —
  negligible for a server-to-server secret; `crypto.timingSafeEqual` is tidier.
- The Svelte `state_referenced_locally` warnings in `dink-test`/`builder` are **harmless**
  (intentional one-time snapshots of `data` into editable `$state`); silence with
  `// svelte-ignore state_referenced_locally` if you want a clean check.

---

## 7. What's already good (no action)

- `formatGP`, `rsnToSlug/slugToRsn` are consistently imported — no inline reimplementations.
- `AccountIcon`, `Lightbox`, `CardThumb/PackThumb` are properly reused.
- The `/api/dink/process` shared-secret guard correctly 403s when unset and accepts bearer or `?key`.
- Token mint/rotate/revoke (`dinkTokens.ts`) mirrors the bot correctly and degrades gracefully.
- `loadEventBoard`'s `built` fallback cleanly preserves the legacy Echo Rumors event.
- Rank scoring math is internally consistent; caching upserts use a single consistent shape.
- hooks.server.ts middleware ordering is correct and well-reasoned.
