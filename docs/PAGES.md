# Building pages — instant navigation

The standard for member-facing and admin pages. Update this doc when you change the
instant-nav modules or the new-page recipe.

## Why

SvelteKit blocks a client-side navigation until the destination's **server** load resolves
— so a page with a `+page.server.ts` load costs at least one network round-trip per
navigation. The member-facing pages avoid that entirely: they have **no server load**, and
clicking a link swaps the page in the same frame with skeletons that fill in as data
streams.

Converted: `/`, `/events`, `/events/[slug]` (serves bingo events too), `/event/[slug]`,
`/events/personal-bingo` (formerly `/clog-bingo`), `/gamba`, `/me`, `/tasks`, and the core
admin pages (see Admin below). Old `/bingo/[slug]` and `/clog-bingo` URLs 301-redirect to
their `/events/...` homes.

## The four shared modules

A new page writes only its data builder and its skeleton markup — everything else is a
one-liner:

- `src/lib/server/apiEndpoint.ts` — `memberEndpoint` / `publicEndpoint` (401 gate +
  no-store JSON), plus `adminEndpoint` / `superAdminEndpoint` / `cardAdminEndpoint`.
- `src/lib/instantLoad.ts` — `instantGuard` (the `'public' | 'member' | 'onboarded' |
  'admin' | 'superAdmin' | 'cardAdmin'` access gates) and `instantLoad` (the whole standard
  universal load).
- `src/lib/swr.ts` — the client-only stale-while-revalidate cache (`swr`, `mapSwr`,
  `emptySwr`, `clearSwrCache`). `cached` is a LIVE getter over the cache, which is what
  makes back/forward revisits first-paint real content.
- `src/lib/swrResource.svelte.ts` — `swrResource` / `swrRouted`, the component-side
  resolvers (state + effect + staleness flag + synchronous cached fallback).

## The recipe for a new page (see `/me` for the simplest live example)

1. **Data builder** in `src/lib/server/` — one exported async function taking the
   `SessionUser` (+ params) and returning a JSON-serializable payload (e.g.
   `meData.ts`, `eventsList.ts`, `eventDetail.ts`, `gambaPage.ts`).
2. **Endpoint** at `src/routes/api/<name>/+server.ts`:
   `export const GET: RequestHandler = memberEndpoint((user) => buildXData(user));`
   Hooks (session/ban/staging gates) run on API requests like any other.
3. **Universal load** at `+page.ts`:
   `export const load: PageLoad = instantLoad<XData, 'x'>({ key: 'x', guard: 'onboarded', url: '/api/x' });`
   (`url` can be a callback for params/query, e.g. `/events/[slug]`.)
4. **Page component**: `const x = swrResource(() => pageData.x, EMPTY_X);` then
   `{#if x.ready} …{x.value}… {:else} <Skeleton /> {/if}`. Resolving into state (rather than
   `{#await}`) keeps the previous data on screen during post-action revalidations instead of
   flashing skeletons.
5. **Form actions stay** in `+page.server.ts` (actions only, no load) — see
   `/` (calendar), `/gamba`, `/me`, `/events/[slug]`.

## Data-dependent first decisions (404 / redirect)

Pages whose first decision needs data return a discriminated payload composing the shared
`Steering` type from `swrResource.svelte.ts` (`{ kind: 'not_found' | 'redirect' }` +
renderable kinds) and resolve it with `swrRouted`: cached renderable payloads still
first-paint synchronously, but only FRESH responses steer (a stale cached redirect/not-found
can never bounce the user), and `notFound` is set ONLY by a real `not_found` payload — a
failed fetch never repaints working content as a 404. `eventDetail.ts` + `/events/[slug]`
are the reference.

## Failure semantics (owned by the shared modules — pages get them for free)

`swr()` never fetches during SSR (the server pass paints skeletons anyway; fetching would
run every builder twice per hard load), reports failures via `Swr.error` (HTTP status, or
null for network), and ticket-guards cache writes so a slow superseded response can't
regress the cache. A failed refresh keeps the previous data on screen. A 401/403 (session
expired, role revoked mid-browse) triggers one throttled `invalidateAll()` so the layout
re-runs and the normal guards redirect — never a permanently skeleton-stuck page. The client
cache is wiped by the full document load logout causes — the logout forms are deliberately
NOT `use:enhance` (commented in place); any future client-side auth transition must call
`clearSwrCache()`.

**Escape hatch:** pages that stream several parts or reshape the payload (home, tasks)
hand-compose `instantGuard` + `swr` + `mapSwr` in their load — `mapSwr` views stay live over
the underlying cache; never snapshot `cached`.

## Rules that make this safe

- Endpoints must re-check `locals` themselves (the client-side gates are UX, not security).
- Type payloads with `import type` from the server builder (type-only imports are erased at
  build, so no server code leaks).
- Keep the root `+layout.server.ts` free of `url`/`params` reads — the zero round-trip
  depends on it not re-running per navigation.

**Known tradeoff:** hard refreshes render skeletons first (content streams after hydration).
Client-side navigation — the overwhelmingly common case for a logged-in member app — is what
this optimizes.

## Admin pages

Same pattern with role-gated endpoint factories: `adminEndpoint` / `superAdminEndpoint` /
`cardAdminEndpoint` re-verify the role server-side on EVERY fetch of `/api/admin/*` — that is
the security boundary. The `'admin'` / `'superAdmin'` / `'cardAdmin'` guards in `instantLoad`
are UX only (redirect/403 before render, using the role flags the root layout exposes).
Admin builders live in `lib/server/admin/*`; form actions and their audit capture stay in
`+page.server.ts`. Converted: `/admin` (hub, zero network), `overview`, `stats`, `audit`,
`voice`, `pack-stats`, `wallets`, `moderation`, `dink-drops`, `submissions`, `events`,
`tasks`. The form-heavy/rare tools (cards, config, admins, tables, inventory, sims,
dink-test, ehb, per-event pages) keep classic server loads on purpose.

Admin pages don't build per-page skeletons: they render their `EMPTY_*` placeholder behind a
"Loading…" note until the payload lands (admins tolerate a plain loading state; member pages
get real skeletons). Convention for the placeholders: admin EMPTYs use a type ANNOTATION
(`const EMPTY_X: NonNullable<PageData['x']['cached']> = {...}`) so the compiler catches drift
when a builder's shape changes; member pages may keep `as unknown as` casts only because they
gate ALL content on `ready`, so a drifted EMPTY can never be dereferenced.

## Route inventory

- **Public:** `/` (roster, calendar, event counts), `/onboarding`, `/me`, `/u/[rsn]`,
  `/auth/*`, `/banned`, `/login-busy` (Discord API degradation).
- **Events / board game:** `/events`, `/events/[slug]` (signups, teams, duo invites,
  leaderboard), `/events/[slug]/board` (3D board: boss/pet/path/tiles), plus the simpler
  `/event/[slug]`.
- **Bingo:** `/events/[slug]` (player, unified), `/admin/bingo/[slug]` (tiles + review).
- **Cards:** `/gamba` (3D pack opener + simulator), `/admin/cards`, `/admin/pack-tester`,
  `/admin/pack-sim`, `/admin/pack-stats`, `/admin/crate-sim`.
- **Tasks:** `/tasks/*` (submit proof), `/admin/tasks`, `/admin/submissions` (review).
- **Admin hub** (`/admin`, role-gated, links shown per role): `events`, `moderation`,
  `wallets`, `stats`, `audit`, `guides`, `admins` (owner role management),
  `overview` (read-only config/roster snapshot); **super-admin only:** `config`
  (bot_config editor), `tables/[table]` (generic table editor), `inventory`.
