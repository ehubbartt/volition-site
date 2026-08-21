# Live updates: drop latency and stale views

> **Status: BUILT (A1 + A2 + B2 + C1); the worker half is not yet deployed.** The site half
> is live (secrets set on both Fly apps and in the Worker, endpoint answering), but the
> proxy's ping + crons sit on the un-merged `drop-drain-ping` branch with `SITE_URL` blank —
> runbook in [`PENDING-OPS.md`](PENDING-OPS.md) § 1. Until that merges and deploys, credit
> latency behaves exactly as the pre-work audit below. The latency/race measurements in
> "How to verify" are still to be taken.

## What shipped

**Layer A — crediting (A1 + A2, in `dink-proxy`):**

- `insertDinkDrops` pings `POST <SITE_URL>/api/dink/process?reconcile=0` after every
  successful insert. Both ingest paths already run under `ctx.waitUntil`, so the ping never
  delays Dink's response — and on prod's `auto_stop_machines = 'suspend'` it *wakes* a
  suspended machine.
- Two cron triggers in `wrangler.jsonc`: every minute a plain drain (bounds worst-case
  credit latency at ~60s if a ping is lost), every 15 minutes a drain **with reconcile**
  (the healing pass for drops whose situation changed after they landed). Handled by the
  worker's `scheduled` export.
- Both no-op unless `SITE_URL` *and* `DINK_PROCESS_SECRET` are configured.

**Layer A, site side:**

- `/api/dink/process` takes `?reconcile=0|1` (default 1, so hand-invocation keeps the old
  behaviour). Pings drain-only; re-churning days of dead drops on every kill would be waste.
- Runs are **serialized per instance** (`runProcessDinkDrops` in
  `src/lib/server/dinkDrops.ts`): one in flight, a burst of pings coalesces into a single
  follow-up run (reconcile flags OR-ed). Cross-instance overlap stays safe via the
  idempotency keys. `maybeProcessDinkDrops` (the poll-on-read backstop) now returns the
  in-flight promise, so the connect4 admin load's `await` actually drains before its
  re-read — previously it awaited `void`.
- The staging admin lock exempts `/api/dink/process` (it authenticates itself by secret),
  so the pipeline can be rehearsed on staging.

**Layer B — the screen (B2, versioned polling), built as the generic pattern:**

- `src/lib/server/liveVersion.ts` — the per-kind change token (count + latest timestamp of
  the table the board derives from, plus event status; connect4 also folds in the structure
  phase, bingo the approved count). Memoized per instance for 1s, so the DB sees ~1 compute
  per second per event **regardless of viewer count**. Never throws.
- `GET /api/live/[eventId]` — member-gated, no-store, ~100 bytes.
- `src/lib/live.svelte.ts` — `liveEvent(eventId, { onChange, intervalMs = 3000, paused,
  initial })`: polls the token, fires `onChange` only when it moves, pauses on hidden tabs
  (immediate poll on return), backs off ×2 to 30s on errors, and re-baselines if the page
  navigates to a different event without a remount. `initial` is the token computed with
  the page payload, so a change landing between render and first poll is still caught.
- **First consumer:** the admin Connect Four board — the old 10s blind `invalidateAll`
  interval is now a 3s version poll that refetches only on change, behind the same
  auto-refresh checkbox and replay guard. Manual claims, undo and simulated drops move the
  same pieces table, so they propagate to every open board identically to Dink credits.

**Layer C:** C1 (do nothing beyond A) — the race window collapses to the drain interval;
measure before doing more.

**The open questions, decided:** 3s polling, no SSE now (the token is the SSE-ready seam);
sized for the full 240-viewer roster (the 1s memo makes viewers ~free); the member Connect
Four page is a separate follow-up that opts in with the same one-liner; no "tile taken"
toast — the objective-swap animation is the notification; secrets runbook in
[`PENDING-OPS.md`](PENDING-OPS.md).

## The ask

| | Requirement |
|---|---|
| **R1** | A drop is credited promptly, without depending on someone loading an unrelated page. |
| **R2** | *"The board view for Connect Four should auto refresh on new submissions so that there is never a stale tile being shown."* |
| **R3** | *"This should be how all future events work"* — a pattern every event kind inherits, not a Connect Four special case. |

R2 is the sharp one. A stale tile is not a cosmetic problem: it is a player farming a boss
for an objective that somebody else already won.

## What happened before this work (the audit that motivated it)

There are **two independent clocks**, and both are effectively unbounded.

### Clock 1 — the drop sits in a queue nothing drains on a schedule

The pipeline is: Dink plugin → Cloudflare Worker (`dink-proxy`) → `INSERT INTO
vs_dink_drops` → *…nothing…* → `processDinkDrops()` credits it.

`POST /api/dink/process` exists for exactly this, and its own header comment says
*"Called by a cron / the dink-proxy after writes."* **Nothing calls it:**

- `dink-proxy/src/index.js` writes the rows and returns. It has no site URL in its env at
  all (`SUPABASE_URL`, `SUPABASE_KEY`, TTLs and `FEED_MIN_VALUE` — that's the list), and
  `wrangler.jsonc` declares no `crons`.
- No job in `volition-discord-bot/jobs/` calls it.
- No scheduled GitHub workflow (`.github/workflows/` is the two deploy files).
- `DINK_PROCESS_SECRET` appears in neither `fly.toml` nor `fly.staging.toml`; without it the
  endpoint answers 403, so it is currently *disabled* as well as uncalled.

So the only thing that drained the queue was the **backstop** in
`src/lib/server/dinkDrops.ts` (since rewritten — see "What shipped"):

```ts
const THROTTLE_MS = 20_000;
export function maybeProcessDinkDrops(): void {
  if (inflight || Date.now() - lastRun < THROTTLE_MS) return;
  …
}
```

Three properties make it unfit as the primary mechanism:

1. **Three callers only** — `bingoPage.ts:65`, `personalBoardPage.ts:36`, and
   `admin/connect4/[slug]/+page.server.ts:64`. Nothing else in the app.
2. **Throttled per server instance.** `lastRun` is module state, so the 20s window is
   per-process, not global.
3. **Fire-and-forget.** It returns `void`; the page does not await it. The load that
   *triggers* a drain still renders the pre-drain data — you see the credit on the *next*
   load, not this one.

### Clock 2 — the view never updates itself

Member event pages have a manual **Refresh** button (`invalidateAll()`) and nothing else.
The only `setInterval` on `routes/event/[slug]/+page.svelte` ticks a countdown clock to the
start time; it never touches the board.

The one exception is the Connect Four **admin tester**, which polls every 10s
(`admin/connect4/[slug]/+page.svelte:349`) behind an auto-refresh checkbox, guarded so it
never yanks the board out from under a replay. That is an admin convenience, not a design,
and there is no member page for Connect Four yet.

### The worked example (Battleship, last event)

A player got a drop and hit Refresh, repeatedly, and did not see it for 10+ minutes. That is
exactly what the code predicts:

- The Battleship page is **not** one of the three that trip the backstop
  (`battleshipPage.ts` never imports it; neither does `apiEndpoint.ts` nor the hook).
- So Refresh re-read a board that genuinely had not changed, because their drop was still
  sitting unprocessed.
- It was credited whenever some unrelated person next opened a bingo or personal board.

**Nothing was broken and the player did nothing wrong.** Both clocks were missing.

## Why Connect Four is worse than Battleship

Battleship tiles are per-player. Connect Four's 25 objectives are **shared between both
clans**, so *every* drop is a race, and the loser needs to know immediately that the tile is
gone. With ~240 players hunting the same 25 objectives, a stale rail wastes real playtime.

## The fairness question, stated precisely

`processDinkDrops` reads its batch `.eq('processed', false).order('received_at', {ascending: true})`
(`dinkDrops.ts:398-403`), and `received_at` is stamped when the proxy's row lands — not when
it is processed. So:

- **Within a batch, the earliest drop wins**, however long both waited. Good.
- **Across batches, it does not.** Drop A at 10:00 stays unprocessed; B at 10:05 arrives and
  a batch runs at 10:06 and credits B; A is processed at 10:12 and loses.

Today the cross-batch window is "until someone opens a bingo board" — unbounded. Shrink the
drain interval and the window collapses to roughly that interval. **The fairness fix is
mostly the latency fix.**

(First-come-wins itself is enforced by `unique (event_id, col, row)` on
`vs_connect4_pieces` — that part is sound and is not in question here.)

## Budgets to design against

| Measure | Today | Target |
|---|---|---|
| kill → row in `vs_dink_drops` | ~1s (proxy) | unchanged |
| row → credited | unbounded (median: whenever a bingo board loads) | < 2s typical, < 60s worst case |
| credited → visible on an open board | unbounded (manual refresh) | < 5s |
| cross-batch race window | unbounded | ≈ the drain interval |

## Option space

### Layer A — getting the drop credited (R1)

| | Option | Trade-off |
|---|---|---|
| **A1** | **Proxy pings `POST /api/dink/process` after `insertDinkDrops`**, via `ctx.waitUntil` so Dink's response isn't delayed. | Event-driven, ~1s. Needs a site URL var + `DINK_PROCESS_SECRET` as a Worker secret *and* a Fly secret. One failed request strands that drop until something else runs. |
| **A2** | **Cloudflare cron trigger** in `wrangler.jsonc` calling the same endpoint. 1 minute is Cloudflare's floor. | Bounded worst case; also keeps the **reconcile** pass running on a schedule (it re-checks recent uncredited drops — e.g. someone who signed up *after* their drop). Alone, a 60s median is too slow for a shared-tile race. |
| **A3** | **Supabase DB webhook** on insert into `vs_dink_drops` → the endpoint. | No proxy change; fires on *any* writer. Another moving part configured outside the repos, and invisible to anyone reading the code. |
| **A4** | **`setInterval` inside the site process.** | Trivial, no secrets. But it duplicates across Fly machines, and dies with a suspended machine — which is precisely when the queue needs draining. |

**Recommended: A1 + A2.** A1 is the latency, A2 is the guarantee. They are small and they
compose. Bonus: with `auto_stop_machines = 'suspend'`, the A1 ping also *wakes* a suspended
machine, so a drop during a quiet spell is still handled.

### Layer B — getting it onto the screen (R2)

| | Option | Trade-off |
|---|---|---|
| **B1** | **Poll the existing page endpoint** every 5–10s (`invalidateAll()`), as the connect4 admin page already does. | Trivial; works today. At 240 viewers × full board payload it is the most expensive option per unit of freshness. |
| **B2** | **Versioned polling.** A tiny `GET /api/live/[eventId]` returning `{version}` (e.g. claim count + latest `claimed_at`); the client polls *that* and only refetches the board when it changes. | ~100 bytes per poll, so 2s polling is affordable at 240 viewers. Cheap to build, no new infrastructure. Still polling. |
| **B3** | **SSE** (`GET /api/live/[eventId]/stream`), server pushes on change. | Genuinely live, one connection per viewer. Needs a cross-instance bus (Postgres `LISTEN/NOTIFY` or Supabase Realtime server-side) the moment Fly runs more than one machine, and connection handling on suspend/deploy. |
| **B4** | **Supabase Realtime straight to the browser.** | Rejected: violates the repo's "DB access is server-only" non-negotiable, and RLS is deny-all so it would mean opening tables to `anon`. |

**Recommended: B2 now, shaped so B3 can replace its transport later.** If the version token
is the contract, swapping polling for SSE is a change behind one client helper.

### Layer C — exact race fairness (optional)

| | Option | Trade-off |
|---|---|---|
| **C1** | **Do nothing beyond Layer A.** | With a ~1s drain the race window is ~1s, which is fair for a drop race. Simplest, and probably correct. |
| **C2** | **Displace on earlier `received_at`** — a later-processed but earlier-received drop takes the tile from its current holder. | Exact. But a piece changing colour minutes later, and runs re-scoring underneath players, is worse UX than a 1s window. |
| **C3** | **Hold-and-settle** — buffer claims for N seconds, then settle in `received_at` order. | Exact and no retractions, at the cost of N seconds of "pending" on every claim, which fights the instant-feedback work already done. |

**Recommended: C1**, and *measure* the window so the decision is evidence-backed rather
than assumed.

## The pattern for all future events (R3) — as built

The goal: an event page opts into live updates with one line, and the freshness mechanism is
owned in one place.

**Server** — `src/lib/server/liveVersion.ts`

```ts
// A cheap, monotonic token for "has anything about this event changed?".
// Per event kind: connect4 = pieces count + max(claimed_at); bingo = completions;
// battleship = shots. One indexed aggregate query, no payload.
export async function liveVersion(eventId: string): Promise<string>
```

**Endpoint** — `GET /api/live/[eventId]` → `{ version: string }`, member-gated, no caching.

**Client** — `src/lib/live.svelte.ts`

```ts
// Polls the version endpoint; calls onChange() when the token moves.
// `paused` exists because a refetch must never interrupt an animation or
// clobber optimistic local state (see the guards below).
export function liveEvent(eventId: string | (() => string), opts: {
  onChange: () => void | Promise<void>;
  intervalMs?: number;   // default 3000
  paused?: () => boolean;
  initial?: string;      // token computed with the page payload (baseline)
}): void
```

**Opt-in, per page:**

```ts
liveEvent(data.event.id, {
  onChange: refresh,
  paused: () => playback.playing || pending.length > 0
});
```

Then Connect Four, Battleship, bingo boards and every future kind get R2 for free, and the
transport can become SSE later without touching the pages.

### Guards the pattern must provide (learned the hard way on this branch)

- **Never clobber optimistic local state.** The Connect Four board merges server pieces with
  a `pending` list of unconfirmed local claims; a refresh mid-flight must not drop them.
- **Never interrupt an animation.** The board's catch-up/replay playback owns the board
  while it runs; the existing poll already guards on `playback.playing`.
- **The 3D board is expensive to rebuild.** A refresh must be data-only — it must not force
  the three.js scene to re-init (that bug has already been fixed once).
- **Don't leak the undealt deck.** When a member view is built, the payload must stay
  `redactSnapshot`-ed; live updates must not become a side channel for upcoming tiles.

## Constraints the design must respect

- **DB access is server-only** (`src/lib/server/`). No client-side Supabase.
- **Member pages use the instant-nav pattern** (`docs/PAGES.md`) — no blocking server load.
- **No migration runner.** Any SQL is hand-applied from `db/scripts/`, idempotent.
- **Prod is `min_machines_running = 1` with `auto_stop_machines = 'suspend'`** and
  `auto_start_machines = true`. Design for 1 machine, but do not *assume* 1: anything
  holding per-process state (the 20s throttle, an SSE subscriber list) is per-instance.
- **Staging is admin-only** (`STAGING_ADMIN_ONLY` in `fly.staging.toml`), so member-facing
  behaviour cannot be tested there by non-admins.
- Repo conventions: topical branch + PR, docs updated in the same commit, and no AI/model
  names anywhere in commits, branches, code or docs.

## Open questions for the planner (answered — see "What shipped")

1. **Staleness budget** — is 3s good enough, or does a shared-tile race justify SSE now?
2. **Concurrency** — how many simultaneous viewers should this hold? 240 is the roster;
   realistic peak is probably lower.
3. **Does the member Connect Four page get built as part of this**, or does the pattern land
   first and the page consume it?
4. **Is a "someone just took tile X" toast** wanted, or is silently-correct enough?
5. **Who owns the secrets** — `DINK_PROCESS_SECRET` has to be set on Fly and in the Worker
   before A1/A2 do anything at all.

## How to verify it worked

- **kill → credited:** insert a row with a known `received_at`, measure until `processed`.
  `scripts/connect4-sim.mjs` already drives real drops through the real consumer.
- **credited → on screen:** the e2e (`e2e/connect4-event.spec.ts`) already measures
  click → pixel for manual claims (~105ms) and objective swap (~940ms); the same harness can
  measure a Dink-originated claim reaching an idle open board.
- **Race window:** submit two drops for the same tile N ms apart and assert the earlier
  `received_at` wins, sweeping N down until it doesn't. That number *is* the fairness
  guarantee, and it belongs in this doc once measured.
