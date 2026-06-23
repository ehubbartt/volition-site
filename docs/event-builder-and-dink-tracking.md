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
                    resolve rsn → vs_users, match item → tile, insert an
                    APPROVED  vs_bingo_completions  row  → tile + leaderboard credit
```

The proxy stays "dumb" (filter + record); all crediting logic lives on the site next
to the rest of the bingo code.

---

## One-time setup

1. **Apply the schema** in the Supabase SQL editor: `db/schema/event_builder.sql`
   (adds `vs_events.structure`, `vs_event_templates`, `vs_event_tiles`,
   `vs_event_tracked_items`, `vs_dink_drops`, and the `vs_active_tracked_items` /
   `vs_active_participants` views the proxy reads).
2. **Site env:** set `DINK_PROCESS_SECRET` (guards `POST /api/dink/process`).
3. **Proxy:** set `SUPABASE_URL` (var) + `SUPABASE_KEY` (`wrangler secret put`), then
   `npx wrangler deploy`. The proxy's `minLootValue` is already lowered to `1` so it
   sees every drop; `FEED_MIN_VALUE` (default 3,000,000) keeps the Discord feed quiet.
   - Auto-tracking is a **no-op until `SUPABASE_URL`/`SUPABASE_KEY` are set**, so the
     proxy is safe to run without it.

---

## Creating an event (admin)

1. Go to **`/admin/events`** → **"Create from template"**. Enter a name, pick a
   template (e.g. *Echo Rumors (bingo)*), submit. This creates a `draft` `vs_events`
   row, clones the template's structure + tiles into `vs_events.structure` and
   `vs_event_tiles`, and drops you into the builder.
2. In **`/admin/events/<slug>/builder`**:
   - **Structure** — rows, hours between row releases, bonus column on/off, and the
     point value per tier. (Legacy `echo-rumors` and any event with no stored
     structure fall back to the hardcoded defaults, so nothing breaks.)
   - **Tiles** — per tile edit name, row, tier, points, image URL, and the
     how-to/FAQ markdown. Add or delete tiles freely; tile ids follow `r<row>-<tier>`
     for the grid and `b<row>` for the bonus column.
   - **Auto-tracked items** (per tile) — add rows of `{item name, item id (optional),
     required qty, source (optional)}`. These are what Dink will match drops against.
     Prefer filling the **item id** (robust against noted/charged name variants); the
     name is used as a fallback. `source` optionally requires the drop's NPC/container
     to match.
3. **Go live:** on `/admin/events`, set the event **status → `open`** and set a
   **start time** (`starts_at`). Rows release on the schedule from the structure
   config. `preview` keeps it admin-only for testing; `closed` archives it.

Verify the board renders at **`/bingo/<slug>`** and reflects your edits. The legacy
`/bingo/echo-rumors` board is unchanged.

---

## Who gets auto-credited

A drop is recorded when **both** hold:
- the dropper's RSN is in `vs_active_participants` — the whole clan roster (`players`)
  plus anyone signed up to an `open` event, lowercased; and
- the looted item matches a row in `vs_active_tracked_items` for an `open` event
  (by item id, else by name; honoring the optional `source`).

On processing, the RSN is resolved to a `vs_users` row and an **approved**
`vs_bingo_completions` row is inserted for that user + tile (idempotent — a tile
already credited for a player is skipped). Bingo tiles are binary, so the first
matching drop credits the tile.

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
backstop on load.) The tile should now show an **approved** completion for the
matched RSN and the leaderboard should update. Re-run → no double credit.

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
