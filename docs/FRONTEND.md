# Frontend conventions & shared UI

Svelte conventions and the reusable UI pieces to build on. Update this doc when you add a
broadly-shared component or change a convention. For page data-loading, see
[`PAGES.md`](PAGES.md).

## Conventions

- **Svelte 5 runes** (`$state`, `$derived`, `$props`, `{#snippet}`/`{@render}`).
- **Form actions** return `{ ok: true }` or `fail(status, { error })`; forms use
  `use:enhance` for optimistic UI. Pending state via `src/lib/busy.svelte.ts` (`createBusy()`).
- **Styling:** scoped component CSS + global design tokens (CSS variables) in `src/app.css`
  (dark theme, orange accent, self-hosted RS fonts). Use the tokens, don't hardcode colors.
- **Server-only** logic stays in `src/lib/server/` so secrets never reach the client.

## Shared UI: OSRS wiki images & bingo tiles

Reuse these instead of re-deriving wiki URLs or re-styling tiles (avoids the casing/format
bugs that used to recur per feature):

- **`src/lib/wikiImage.ts`** — the single source of truth for OSRS Wiki image URLs. Core
  `wikiFileName()` / `wikiImageUrl()` (first letter upper-cased, spaces→`_`, apostrophes
  `%27`; the rest is **case-sensitive**, so pass canonical wiki casing — e.g. the monster
  `Shellbane gryphon`, not `Shellbane Gryphon`), plus `wikiThumbUrl()` for scaled renders and
  the typed helpers `itemImageUrl`, `skillImageUrl`, `monsterImageUrl` (with a raid alias map),
  and `caTierImageUrl`. `itemIconUrl` (`$lib/osrsItems`), `skillIconUrl` (`$lib/ehp`) and the
  CA icon fns (`$lib/ca`) are thin re-exports of these — don't fork new copies.
- **`src/lib/WikiImage.svelte`** — an `<img>` with the hotlink incantation baked in
  (`referrerpolicy="no-referrer"` + hide-on-404); renders nothing for an empty `src`.
- **`src/lib/BingoTile.svelte`** — the reusable board tile (bronze OSRS button frame, icon on
  a light parchment disc so even dark glyphs like the Agility icon stay visible, clamped name
  + optional sub-line, `obtained` green ring, `highlighted` accent glow). Props: `image`,
  `name`, `sub`, `obtained`, `highlighted`, `title`, `imageSize`. Drop it into a CSS grid; the
  personal collection-log board (`/events/personal-bingo`) maps its item/skill/CA tiles onto
  it, and event/bingo grids should do the same.
- **`src/lib/Skeleton.svelte`** — the shimmer placeholder used behind streamed page data
  (see [`PAGES.md`](PAGES.md)).
