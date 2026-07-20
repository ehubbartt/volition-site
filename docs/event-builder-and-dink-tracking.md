# Creating an event & testing Dink auto-tracking

How an admin builds a bingo event from a template, attaches auto-tracked items to
tiles, and verifies the end-to-end Dink pipeline credits those tiles automatically.

> Companion code: the `dink-proxy` Worker (separate repo) writes matched drops to
> `vs_dink_drops`; this site drains that table and credits tiles. See
> `dink-proxy/docs/bingo-auto-tracking.md` for the proxy-side design.

---

## How the pipeline fits together

```
RuneLite + Dink  ──POST /hook/<token>/achievements──▶  dink-proxy Worker
                                                          │
                              Decision A: forward to Discord only if value ≥ FEED_MIN_VALUE
                              Decision B: player ∈ vs_active_participants
                                          AND item ∈ vs_active_tracked_items
                                          → insert row in  vs_dink_drops
                                                          │
   site: processDinkDrops()  ◀── POST /api/dink/process (cron)  +  board-load backstop
                                                          │
                    resolve rsn → vs_users, look up THIS user's active item tiles
                    in vs_active_player_tiles, credit each match (event tile → an
                    APPROVED vs_bingo_completions row; personal-board tile → flip
                    obtained) → tile + leaderboard credit
```

The proxy stays "dumb" (filter + record); all crediting logic lives on the site next
to the rest of the bingo code. Both the proxy's record filter and the site's crediting
read from **one source of truth** — the per-player active-tiles index below.

---

## The per-player active-tiles index (`vs_active_player_tiles`)

A single **live SQL view** is the source of truth for "what tile is each player
currently on," across **all** trackable surfaces. One row = one tile a player can
currently complete. It's a view, so it's always fresh — a closed event, a completed
tile, or a regenerated board makes rows appear/disappear with no triggers, refresh job,
or staleness.

Each row carries a **`type` discriminator** so each tracker reads only the tiles it
understands:

- **`item`** tiles carry an `item_id` + `match_type` and are auto-credited by Dink.
  Sources: open-event tracked-item tiles, and personal collection-log board tiles.
- **`manual`** tiles (event tiles with no tracked item) are proof-submission only.
  They're represented for completeness but the Dink consumer ignores `type<>'item'`.

It unions four producers (`db/scripts/active_tiles.sql`):

1. **Event item tiles** — each signed-up user × the tile's tracked item(s), excluding
   tiles they've already completed. Only for events that are `status='open'` **and have
   already started** (`starts_at is null or starts_at <= now()`), so the served allowlist
   matches what can actually credit — items aren't served before the event starts.
   `activated_at` = the event's `starts_at`.
2. **Event manual tiles** — signed-up user × event tiles with no tracked item.
3. **Personal board tiles** — each owner × their not-yet-obtained board tiles, but only
   for a **locked** board (a draft isn't tracked), and only the `kind='item'` tiles. Default
   `match_type='collection'` (owned/test tiles opt into `'loot'`). `activated_at` = the
   board's `locked_at`, so drops obtained before locking never credit. (Personal boards can
   also carry `kind='skill'` tiles tracked via WiseOldMan XP and `kind='ca'` tiles tracked via
   WikiSync — those are re-poll only and deliberately never enter this Dink index.)
4. **Manual pins** (`vs_dink_manual_items`) — event-decoupled items pinned to a member for a
   while (or permanently). `kind='pin'`, `type='item'`; they exist ONLY to put an item in the
   member's served allowlist (e.g. the connection self-test pins Bones), and are **never
   completable** — the credit consumer skips `kind='pin'`. Expiry is DECLARATIVE (a pin counts
   only while `expires_at is null or expires_at > now()`), so there is no prune job.

**One shared server API.** `src/lib/server/dinkAllowlist.ts` is the single documented entry
point for "what should this member's Dink track right now" — it reads the view
(`getTrackedItemsForUser` / `getTrackedItemsForToken`) and manages the pin source (`pinItem`,
`pinSelfTest`/`clearSelfTestPin`). The Dink consumer (`dinkDrops.ts`) reads tracked tiles
through it; the proxy reads the derived views directly.

The proxy's `vs_active_tracked_items` / `vs_active_participants` views (and per-token
`vs_dink_token_items`) are **derived from the `item` subset** of this index, so a new event,
personal board, or pin automatically enters the proxy's allowlist with no other change. (The
proxy reads them by name; their column shapes are unchanged.)

**Activation rule (no retroactive credit).** A drop credits a tile **only if
`drop.received_at >= activated_at`** for that player+tile. For events the existing per-row
release timing gate refines this further; for personal boards it means a drop obtained
*before* the board was **locked** never credits it (and a draft board isn't tracked at
all). Generating or locking a board does **not** back-fill past drops.

**Per-user-correct.** A drop is matched against the **dropper's own** active tiles only,
so it can only ever complete that player's tiles. One drop may legitimately credit both an
event tile **and** a personal-board tile for the same player — every matching candidate
that passes its activation check is credited.

**Manual submission always coexists.** The `type` discriminator governs *auto-tracking
only*, never whether a tile can be submitted manually. Every event tile keeps its
`/bingo` proof-submission + admin-review path as a safety net if Dink misses or mis-fires;
the unique approved index on `vs_bingo_completions(event_id,user_id,tile_id)` dedupes a
double credit (first to approve wins). Personal-board manual claims go through the same
review: "Mark done" files a PENDING `vs_submissions` row (source `manual`) that surfaces
in `/admin/submissions`; the tile shows "Pending review" and only ticks once approved.
Dink/clog/WoM/WikiSync auto-credits skip review (they insert approved, source `dink`/
`clog`/etc.). The automatic manual-free check remains the "Check progress" re-poll button.

**Race healing.** `vs_dink_drops` stays the durable recent-drops log. The cron/proxy path
(`POST /api/dink/process`) runs a bounded **reconcile** pass that re-checks recent
un-credited drops (the last 3 days, outcomes `no_tile`/`no_user`) against the *current*
view, so a drop that arrived just before a signup/board existed still heals — but only
ever subject to the activation rule above, never crediting a pre-activation drop. The
poll-on-read backstop stays drain-only so it remains cheap.

---

## One-time setup

1. **Apply the schema** in the Supabase SQL editor: `db/schema/event_builder.sql`
   (adds `vs_events.structure`, `vs_event_templates`, `vs_event_tiles`,
   `vs_event_tracked_items`, `vs_dink_drops`), then **`db/scripts/dink_manual_items.sql`**
   (the `vs_dink_manual_items` pin table — apply BEFORE the view), then
   **`db/scripts/active_tiles.sql`** (the per-player active-tiles index
   `vs_active_player_tiles` — now including the manual-pin branch and the start-date gate —
   and the `vs_active_tracked_items` / `vs_active_participants` proxy views derived from it),
   plus `db/scripts/dink_tracking_hardening.sql`. Re-apply `db/scripts/events_unlisted.sql`
   to retire the old fake `dink-self-test` event.
2. **Site env:** set `DINK_PROCESS_SECRET` (guards `POST /api/dink/process`).
3. **Proxy:** set `SUPABASE_URL` (var) + `SUPABASE_KEY` (`wrangler secret put`), then
   `npx wrangler deploy`. The proxy injects tracked-item names into Dink's **loot
   allowlist** when it serves `/config/<token>` — **per token**: only the items active
   for THAT member (their event signups + locked personal board), read from
   `vs_dink_token_items` (`db/scripts/dink_token_items.sql`), falling back to the
   clan-wide `vs_active_tracked_items` union if the per-token lookup fails. Completing
   a tile drops its item from the member's allowlist on the next config serve. Items
   reach the proxy regardless of value while `minLootValue` stays high (no firehose).
   `FEED_MIN_VALUE` still gates what's forwarded to the Discord feed.
   - Auto-tracking is a **no-op until `SUPABASE_URL`/`SUPABASE_KEY` are set**, so the
     proxy is safe to run without it.
   - Allowlist propagation isn't instant: Dink re-fetches the dynamic config
     periodically and the proxy caches it (`CONFIG_TTL_MS`), so allow a few minutes
     after an event opens before its tracked items start arriving.

> **Timing:** a drop only credits a tile if it was received while that tile was
> actually open — i.e. after the event started and after the tile's row released.
> Drops obtained earlier are discarded (same rule as a manual board submission).

---

## Tile completion types — WATCH BOTH WAYS

A drop credits a tile if the item id/name matches, **regardless of how it arrived** — a
LOOT drop *or* a collection-log unlock both credit, and `processDinkDrops` credits on
whichever fires first (the unique approved index makes a double-fire a safe no-op). Matching
does **not** consult `match_type`. This is deliberate: it removes the entire class of "the
item never tracked because its `match_type` was tagged wrong," and it fixes already-owned
items on personal boards — an owned item fires no *new* collection-log unlock, but a LOOT
drop of it still credits the tile.

`match_type` (`loot` default; `collection` for clog-only items and pets) is now **display /
intent only**. It no longer gates crediting. It still informs the personal-board generator
(owned→`loot`, missing→`collection`) and the `/admin/dink-drops` verdict view.

**How each notification reaches the proxy.** LOOT drops reach the proxy via the loot
allowlist (which now carries *every* tracked item, loot- and collection-tagged alike, so a
mis-tag can't keep an item out of the allowlist). Collection-log unlocks aren't value-gated,
so they always reach the proxy regardless of the allowlist — which is why a multi-server
member's tile can credit via a clog unlock without a Dink config reload.

Combat-achievement / level / KC tiles aren't wired yet (no captured payload); the
framework extends to them once we have one.

## Collect-N tiles

A tracked item's **required quantity** is honored: a tile that needs N of an item only
credits once the player's accumulated quantity (summed across drops of that item) reaches
N. In-progress drops are recorded as `partial` and visible in the drops debug view.

## Debugging: the Dink Drops view

`/admin/dink-drops` lists every matched drop with the consumer's **verdict**
(`credited` / `no_tile` / `no_user` / `timing` / `duplicate` / `partial`). Filter to
"Didn't credit" to answer "why didn't I get credit?". Per drop you can **Reprocess**
(re-run after adding the tile / fixing an RSN) or **Un-credit** (reverse a wrong credit).

## Discord announcements

When a tile auto-completes on an **open** event, an embed is posted to
`DISCORD_BINGO_WEBHOOK_URL` (falls back to `DISCORD_DROPS_WEBHOOK_URL`). The self-test no
longer has an event, so nothing to suppress there (`FEED_SUPPRESS_SLUGS` in `dinkDrops.ts`
is now empty, kept as an extension point).

## The Dink Self-Test (zero-friction connection check)

`/dink-check` is the member-facing "is my Dink working?" page. It's powered by a **manual
pin**, not an event: opening the page calls `pinSelfTest` (`dinkAllowlist.ts`), which upserts
a `vs_dink_manual_items` row for **Bones** (`reason='self-test'`) with a short, refreshed TTL
(`SELF_TEST_TTL_MS`, 90 min). That pin makes Bones a `kind='pin'` row in
`vs_active_player_tiles` → into the member's served loot allowlist, so their Bones drop
reaches the tracker and shows on the page. A `kind='pin'` row is **never completable** (the
credit consumer skips it), so there's no completion to worry about and no astronomical
`required_qty` hack. Removal is clean and needs no prune job: a verifying Bones drop calls
`clearSelfTestPin` (pipeline proven), and otherwise the pin **expires declaratively** — the
view simply stops emitting it once `expires_at` passes. Member flow: open `/dink-check` →
kill a chicken → the drop appears within seconds. No joining, no admin action.

> Replaces the old fake `dink-self-test` `vs_events` row + `vs_event_signups` enroll/prune.
> `events_unlisted.sql` retires that row on re-apply. The **`unlisted`** column stays for real
> unlisted events — hidden from `/events`, home stats, and bot announcements but fully
> functional by direct link.

## Per-user config URLs (Dink tokens)

Each member uses a **personal** Dink config URL — `${PROXY_BASE_URL}/config/<token>` —
pasted into RuneLite → Dink → Advanced Settings → **Dynamic Config URL**. The token
identifies the link and can be **revoked or rotated** at any time.

Tokens live in the `dink_tokens` table (`token`, `discord_id`, `created_at`,
`revoked_at`) and are minted in two equivalent places:

- **Discord bot** (`volition-discord-bot`) — the `/dink` command (mint / fetch) and
  `/dink-revoke` (admin), with auto-revoke when a member leaves the clan.
- **Site** (`src/lib/server/dinkTokens.ts`) — every member can get/copy/**rotate**
  their link at **`/dink-check`**; admins can revoke any member's token from the
  **Dink Drop Simulator** admin page (`/admin/dink-test`).

Both write the same table (keyed by Discord id, so a member has one active token
whichever way they got it). The **proxy validates an incoming token against the union
of** the active `dink_tokens` rows **and** its legacy `VALID_TOKENS` secret, cached for
`TOKENS_TTL_MS`. So a token minted on the site works without any Cloudflare API call,
and a revoke/rotate takes effect within the cache TTL.

> Site env: set `PROXY_BASE_URL` (e.g. `https://dink-proxy.<account>.workers.dev`) so
> the site can show the full config URL. Without it, members fall back to `/dink`.

### Multi-server members (two config variants)

The proxy serves **two variants** of the config, picked per token:

- **Standard** — the admin template as-is (today `minLootValue: 1`, so every drop
  reaches the proxy and members never touch Dink after setup).
- **Multi-server** — for members whose Dink also posts to **other Discord servers**:
  a 1 gp threshold would fire their other webhooks on every drop. Their config keeps
  a floored `minLootValue` (≥ 3,000,000 regardless of the admin template) and relies
  on the injected **tracked-item allowlist** instead. Trade-offs, explained in their
  setup flow on `/dink-check`: they must **toggle the Dink plugin off/on whenever
  their boards/tiles change** (the allowlist only refreshes when Dink reloads the
  config), and their other servers still see notifications for the whitelisted items
  when they drop.

The flag is `dink_tokens.multi_server` (`db/scripts/dink_tokens_multi_server.sql`),
set by the "I use Dink with multiple Discord servers" checkbox on `/dink-check`
(`?/setMultiServer`), carried across token rotations by the site, and read by the
proxy in the same query it already uses to validate tokens. Multi-server members
skip the "reset Dink's settings" setup step.

---

## Creating an event (admin)

1. Go to **`/admin/events`** → **"Create from template"**. Enter a name, pick a
   template (e.g. *Echo Rumors (bingo)*), submit. This creates a `draft` `vs_events`
   row, clones the template's structure + tiles into `vs_events.structure` and
   `vs_event_tiles`, and drops you into the builder.
2. In **`/admin/events/<slug>/builder`**:
   - **Structure** — rows, hours between row releases, the bonus column (on/off +
     its name/points), and the **columns**: add, remove, rename, and set the point
     value of each scoring column. Saving rebuilds the tile grid to match (adds blank
     tiles for new columns/rows, removes ones that no longer fit) while keeping the
     content of tiles that remain. A cloned template starts as a **blank** grid of the
     right shape — not the tiles of a past bingo. (Legacy `echo-rumors`, and any event
     with no stored structure, fall back to the hardcoded defaults so nothing breaks.)
   - **Tiles** — per tile edit name, row, column, points, image URL, and the
     how-to/FAQ markdown. Tile ids follow `r<row>-<columnKey>` for the grid and
     `b<row>` for the bonus column.
   - **Auto-tracked items** (per tile) — add rows of `{item name, item id, required
     qty, source (optional)}`. Start typing an item name and pick from the
     **autocomplete** to fill the id automatically (backed by a bundled OSRS item
     dataset, including untradeables). The id is preferred for matching (robust against
     noted/charged name variants); name is the fallback. `source` optionally requires
     the drop's NPC/container to match.
3. **Go live:** on `/admin/events`, set the event **status → `open`** and set a
   **start time** (`starts_at`). Rows release on the schedule from the structure
   config. `preview` keeps it admin-only for testing; `closed` archives it.

Verify the board renders at **`/bingo/<slug>`** and reflects your edits. The legacy
`/bingo/echo-rumors` board is unchanged.

---

## Who gets auto-credited

A drop is recorded when **both** hold:
- the dropper's RSN is in `vs_active_participants` — distinct owners of any active item
  tile (open-event signups + personal-board owners + pinned members), lowercased; and
- the looted item matches a row in `vs_active_tracked_items` (by item id, else by name —
  **any `match_type`**; watch both ways).

On processing, the RSN is resolved to a `vs_users` row and the drop is matched against
**that user's own** completable `type='item'` rows in `vs_active_player_tiles` (`kind='pin'`
rows are excluded — they whitelist an item but are never completable). Matching is by item
id/name **regardless of notif type** — a LOOT drop or a collection-log unlock both credit the
tile (the unique approved index makes a double-fire a safe no-op). Each matching candidate
that passes its activation check is credited:
- **event tile** → an **approved** `vs_bingo_completions` row (idempotent; the unique
  approved index is the hard guard);
- **personal-board tile** → the tile is flipped `obtained=true`.

Bingo tiles are binary, so the first qualifying drop credits the tile. The verdict
(`credited` / `no_tile` / `no_user` / `timing` / `duplicate` / `partial`) and the
attributed tile are stamped on the drop — personal-board credits as `p:<board_id>:<idx>`
so **Un-credit** can reverse either kind.

---

## Testing the Dink proxy with your event

### A. Proxy in isolation (local `wrangler dev`)

From the `dink-proxy` repo, run the Worker locally pointed at your Supabase, with a
test token allow-listed:

```sh
npx wrangler dev --local \
  --var VALID_TOKENS:testtoken123 \
  --var WEBHOOK_ACHIEVEMENTS:<a real or throwaway Discord webhook> \
  --var FEED_MIN_VALUE:3000000 \
  --var SUPABASE_URL:https://<project>.supabase.co
# SUPABASE_KEY must be a secret in dev: add it to .dev.vars
```

1. **Config endpoint** — `curl http://127.0.0.1:8787/config/testtoken123` returns the
   Dink config JSON with `{{TOKEN}}` substituted and `minLootValue:1`.
2. **Matched drop** — POST a LOOT payload whose `playerName` is a clan RSN and whose
   item id is one you attached to a tile (shape per
   `dink-proxy/docs/dink-payloads.md`):

   ```sh
   curl -X POST http://127.0.0.1:8787/hook/testtoken123/achievements \
     -H 'Content-Type: application/json' \
     -d '{"type":"LOOT","playerName":"<clan rsn>","extra":{
          "items":[{"id":<tracked item id>,"quantity":1,"priceEach":10,"name":"<item>"}],
          "source":"<npc>"}}'
   ```

   Expect a new row in **`vs_dink_drops`** (Supabase). POST the same payload twice →
   still **one** row (dedup via the `drop_key` unique constraint).
3. **Discord feed policy** — a LOOT total **below** `FEED_MIN_VALUE` returns `204`
   (recorded but not forwarded); **at/above** it is forwarded to the achievements
   webhook. Confirms the channel won't flood now that `minLootValue` is `1`.
4. **Auth** — a token not in `VALID_TOKENS` returns `401` on both `/config` and
   `/hook`.

### B. Credit the tile (site)

After a matched drop lands in `vs_dink_drops`:

```sh
curl -X POST https://<site>/api/dink/process \
  -H "Authorization: Bearer $DINK_PROCESS_SECRET"
# → {"processed":N,"credited":M}
```

(or just load `/bingo/<slug>` — the board runs a throttled `processDinkDrops()`
backstop on load; `/events/personal-bingo` runs the same backstop for personal
boards.) The tile should now show an **approved** completion for the matched RSN
and the leaderboard should update. Re-run → no double credit.

**Drop screenshots as proof.** When the Dink client attaches a screenshot to the
notification (loot ≥ `lootImageMinValue`, default 3m, and all collection unlocks),
the proxy uploads it to the `vs-bingo-proofs` bucket (`dink/<drop_key>.<ext>`) and
stamps the public URL on the drop row (`vs_dink_drops.image_url`). The consumer
copies that URL into the credited completion's `proof_urls`, so auto-credited tiles
carry the actual drop image for review. Imageless drops credit with no proof, as
before.

### C. End-to-end with real Dink (deployed)

1. Deploy the proxy with the lowered threshold + Supabase secrets.
2. Create a throwaway `open` bingo event with one **cheap** tracked item (a common
   drop), so it's easy to trigger.
3. In RuneLite, the player on the clan roster uses Dink **"Send Test"** on the loot
   notifier, or simply gets the real drop.
4. Within the manifest cache TTL (~30s) + the processor interval, the tile
   auto-completes on `/bingo/<slug>`. Confirm the Discord achievements feed is **not**
   flooded by sub-`FEED_MIN_VALUE` loot.

---

## Troubleshooting

- **Drop not recorded (`vs_dink_drops` empty):** RSN not in `vs_active_participants`
  (not on the clan roster / not signed up), item id+name don't match any tracked item,
  the event isn't `open`, or the proxy has no `SUPABASE_URL`/`SUPABASE_KEY`. Manifest
  is cached ~30s — allow a moment after editing tracked items.
- **Recorded but tile not credited:** the dropper's RSN doesn't resolve to a
  `vs_users` row (they haven't onboarded on the site), or the tile is already credited
  for them. Check the row's `processed` flag and re-hit `/api/dink/process`.
- **Discord channel flooding:** raise `FEED_MIN_VALUE`; it gates Decision A only and
  doesn't affect tracking.
