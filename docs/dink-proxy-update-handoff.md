# Dink-proxy update — handoff for a new session

**Purpose.** Bring the `dink-proxy` Cloudflare Worker in sync with the changes made in
`volition-site` (the unified per-player active-tiles index + personal collection-log
boards). Most of this is **verifying compatibility**; a few **behavioral** updates are
needed so collection-log tracking and the now event-less tracked-item set work.

> This session has the `dink-proxy` repo. `volition-site` is the companion (the views +
> the consumer live there). Read this whole doc before changing the proxy — several items
> are "verify, don't blindly change."

---

## 0. TL;DR of what changed on the site

- Drop→tile matching moved from **per-event tracked items** to a single live SQL view
  **`vs_active_player_tiles`** — one row per tile a player can currently complete, across
  all open events **and** their personal collection-log board, each typed `item`/`manual`.
- The proxy's two allowlist views, **`vs_active_participants`** and
  **`vs_active_tracked_items`**, were **dropped and recreated** as views *derived from the
  `item` subset* of that index. **Same names, narrower/different columns.**
- New **personal collection-log boards** (`/clog-bingo`): a member generates a board of
  clog items they're missing and **locks it in**; its items then become trackable. These
  are `match_type = 'collection'`. Only **locked** boards are tracked.
- **`vs_dink_drops`** gained columns: `notif_type`, `outcome`, `value`, `tile_id`,
  `source`.
- The site consumer (`processDinkDrops` in `src/lib/server/dinkDrops.ts`) now resolves the
  dropper → site user → **that user's** active `item` tiles from the view, and credits each
  match (event tile → approved completion; personal-board tile → flip `obtained`). **It no
  longer uses the drop's `event_id` to match.**

---

## 1. Contract A — what the proxy READS (⚠️ the #1 risk)

The proxy reads these two views by name from Supabase. Their **current** definitions
(`volition-site/db/scripts/active_tiles.sql`):

```sql
-- columns: rsn (text, lowercased, distinct)
create view vs_active_participants as
  select distinct lower(rsn) as rsn
  from vs_active_player_tiles
  where rsn is not null;

-- columns: item_id (int), item_name (text), match_type (text)
create view vs_active_tracked_items as
  select distinct item_id, item_name, match_type
  from vs_active_player_tiles
  where type = 'item';
```

**ACTION (must do):** grep the proxy for every read of these two views (PostgREST
`?select=...`, `.from('vs_active_participants')`, raw SQL, etc.). For each:

- Confirm it only selects columns that still exist: `rsn` for participants; `item_id`,
  `item_name`, `match_type` for tracked items.
- The **old** views (from the now-removed hand-applied `event_builder.sql`) very likely
  exposed **more** columns — most plausibly `source_name` (NPC/container constraint) and
  `event_id`. **If the proxy selects a column that no longer exists, the PostgREST query
  errors and the proxy records nothing.** This is the most likely breakage.

**If the proxy needs `source_name` and/or `event_id`:** those must be **added back to the
view** in `volition-site/db/scripts/active_tiles.sql`, not worked around in the proxy.
`vs_active_player_tiles` can expose `source_name` from its event-tracked-items branch
(personal-board rows have no source → null). That's a small volition-site change
(drop + recreate the derived view, re-apply in Supabase). Decide based on whether the
proxy actually uses the column.

**Semantics also changed for participants.** Old: roughly "whole clan roster ∪ open-event
signups". New: "distinct owners of any **active item tile**" = open-event signups +
**locked** personal-board owners. This intentionally **narrows** recording to players
actually in play. If the proxy relied on the full roster being present, confirm that's
acceptable (it is, by design — non-participants shouldn't be recorded).

---

## 2. Contract B — what the proxy WRITES to `vs_dink_drops`

Columns the consumer + admin views rely on (schema in
`volition-site/db/scripts/dink_tracking_hardening.sql`; everything else has a default):

| Column        | Type           | Proxy sets? | Notes |
|---------------|----------------|-------------|-------|
| `rsn`         | text           | yes         | dropper RSN |
| `item_id`     | int (nullable) | yes         | id preferred for matching |
| `item_name`   | text (nullable)| yes         | name fallback |
| `quantity`    | int            | yes         | drives collect-N accumulation |
| `source`      | text (nullable)| if known    | NPC/container |
| **`notif_type`** | text        | **yes**     | **`'loot'` or `'collection'` — critical (see §3)** |
| `value`       | bigint (nullable)| if known  | gp value (feed threshold + debug view) |
| `dink_ts` / `received_at` | timestamptz | yes | drop time — the **activation rule** compares `received_at` to the tile's activation time |
| `drop_key`    | text (unique)  | yes         | dedupe key (unchanged) |
| `processed`   | bool           | yes (false) | consumer flips it |
| `event_id`    | uuid (nullable)| **null/omit** | no longer used for matching (see §3) |
| `tile_id`, `outcome` | —       | **no**      | filled by the consumer; leave null |

---

## 3. Required proxy updates (checklist)

1. **[Verify] View column compatibility (Contract A).** The single most important item.
   Fix any `select` that references a dropped column. Most everything else "just works" if
   this passes.

2. **[Behavioral] Record COLLECTION notifications.** For Dink **collection-log unlock**
   notifications where the item is in `vs_active_tracked_items` with
   `match_type = 'collection'`, write a `vs_dink_drops` row with **`notif_type = 'collection'`**.
   This is what makes personal boards (and event clog/pet tiles) auto-complete. If the proxy
   already records collection notifs for event clog tiles, personal boards work
   automatically once Contract A passes — just confirm the path exists and sets
   `notif_type` correctly.

3. **[Behavioral] Don't require an event match to record.** The tracked-item set is now a
   **flat list with no `event_id`**. Record a drop when: dropper ∈ `vs_active_participants`
   **and** item ∈ `vs_active_tracked_items` (matching the notif type). Set `event_id` to
   **null** (the consumer resolves the actual tile(s) per user via the view). If the proxy
   currently looks up "which event does this item belong to" before recording, that lookup
   can be removed.

4. **[Config allowlist] Inject only `match_type = 'loot'` items into Dink's loot
   allowlist.** The config endpoint injects tracked-item names so cheap **loot** reaches the
   proxy despite `minLootValue`. Collection items arrive via Dink's **collection-log
   notifier** regardless and must **not** go in the loot allowlist. Filter the injected set
   to `match_type = 'loot'`.

5. **[notif_type] Make sure every recorded row sets `notif_type`.** Older proxy code may
   not set it; the column defaults to `'loot'`, which would silently drop every collection
   match (the consumer requires `match_type === notif_type`).

6. **[value] Populate `value`** when known (optional; used by the feed threshold and the
   `/admin/dink-drops` debug view).

### Do NOT change
- The view **names** or the `vs_dink_drops` **write contract**.
- The existing event loot flow: Discord forward (Decision A), `drop_key` dedupe, token
  validation/serving.

---

## 4. Test plan

**Consumer side is already independently testable** from the site, so you can validate the
DB end without the proxy: `volition-site` → `/admin/dink-test` now has **Target = Personal
board** and a **Drop type = loot/collection** selector, plus `/admin/dink-drops` shows every
recorded row + its verdict.

**End-to-end (proxy + site), on staging Supabase:**
1. On staging, `/clog-bingo` → generate **and lock** a personal board containing a known
   clog item (note its item id).
2. `POST` a Dink **COLLECTION** payload to the proxy `/hook/<token>/...` for that player's
   RSN + item id.
   → expect a new `vs_dink_drops` row with `notif_type = 'collection'`, `event_id` null.
3. Run the site consumer: `POST /api/dink/process` (shared-secret).
   → the personal-board tile flips `obtained = true` (visible on `/clog-bingo`).
4. Sanity-check the views directly: `select * from vs_active_participants where rsn ilike
   '<rsn>'` and `select * from vs_active_tracked_items where item_id = <id>` both return rows.
5. **Event regression:** an open-event **loot** tile still records (`notif_type = 'loot'`)
   and credits as before.
6. **Activation rule:** a collection drop with `received_at` **before** the board's
   `locked_at` must NOT credit; after, it does. (The consumer enforces this.)

**Local proxy dev:** see `dink-proxy/docs/bingo-auto-tracking.md` and
`dink-proxy/docs/dink-payloads.md` for `wrangler dev` setup and payload shapes.

---

## 5. Cross-repo coordination

- **Views** (`vs_active_participants`, `vs_active_tracked_items`, `vs_active_player_tiles`)
  live in `volition-site/db/scripts/active_tiles.sql`. If the proxy needs more columns,
  change them **there** (drop + recreate the derived view) and re-apply in the Supabase SQL
  editor. Apply order: `personal_boards.sql` → `active_tiles.sql`.
- **`vs_dink_drops`** columns: `volition-site/db/scripts/dink_tracking_hardening.sql`.
- Site-side companions to read for full context:
  `volition-site/docs/event-builder-and-dink-tracking.md` and
  `volition-site/docs/dink-events-diagram.html`.

## 6. Open questions to answer by reading the proxy

1. Which columns does the proxy `select` from each view today? (Drives whether §1 needs a
   view change.)
2. Does the proxy already handle Dink **collection-log** notifications, or only LOOT? (If
   only loot, §3.2 is real new work.)
3. Does it set `notif_type` on the recorded row today? (If not, §3.5.)
4. Does it require an event match before recording? (If so, §3.3 simplifies it.)
5. Does the loot-allowlist injection currently include collection items? (If so, §3.4.)
