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

## Theming (selectable site themes)

Members can pick a site theme on `/me` (Profile tab). A theme is **only a token-override
block** — components read the CSS variables and never know themes exist, so new pages and
future themes compose automatically.

How it flows:

1. **Registry** — `src/lib/themes.ts` lists every theme (`value`, `label`, `description`,
   picker swatches) plus `THEME_COOKIE`/`isTheme()`. Single source of truth.
2. **Persistence** — the `?/saveTheme` action on `/me` writes the choice to the `vs_theme`
   cookie (1 year). Cookie, not DB, on purpose: the server must know the theme before
   rendering *any* page, without a per-request DB read.
3. **SSR** — `hooks.server.ts` validates the cookie into `locals.theme` and stamps it into
   `app.html`'s `<html data-theme="%vs.theme%">` via `transformPageChunk`, so first paint
   is already themed (no flash). The root layout exposes it as `data.theme` for the picker.
4. **CSS** — `src/app.css` ends with one `:root[data-theme='…']` block per theme that
   overrides tokens only (`--accent`, `--surface*`, `--border*`, `--yellow`, `--heading`,
   the `--bg-*` page-background layers, and `--stone-fill`/`--stone-blend`). Every theme
   keeps the real `tile.png` stone texture: themes set `--stone-blend: luminosity`, so
   the tile supplies the grain and `--stone-fill` supplies the hue. `--heading` exists so
   a theme can recolour headings independently of links/buttons (e.g. Clan Hall's
   gold-on-purple).
5. **Instant switch** — the picker flips `document.documentElement.dataset.theme` on click
   and then submits the form, so the change is live before the cookie round-trip.

**Adding a theme:** one entry in `themes.ts` + one token block in `app.css`. Keep themes to
hue shifts (no extra glows/effects) so the shared OSRS sprites (gold borders, bronze
buttons, stone tiles) fit every theme. Current themes: `default` (Old School), `ember`
(Emberforge), `royal` (Clan Hall).

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
- **`src/lib/RankUpCelebration.svelte`** — full-screen confetti + badge overlay shown when
  a "Check my rank" on /me SAVES a higher rank than the player had (the checkRank action
  returns `form.rankUp {from,to}`). Click/Escape/8s dismisses; confetti honors
  prefers-reduced-motion.
- **`src/lib/ItemInfoModal.svelte`** — the shared "OSRS thing info" modal (backdrop, icon,
  heading, label/value `rows`, `wikiPages` ↗ links, close on backdrop/Escape). Extras render
  as children and keep the caller's scoped styles. Used by the personal-bingo tile detail
  and the rank gear grid — reach for it whenever a page needs "click an item → wiki info".
- **`src/lib/InfoTip.svelte`** — the ⓘ button with an instant CSS tooltip (hover/focus/tap;
  used for the rank-component explainers and the personal-bingo toggle data-source tips).
  Safe inside a `<label>` — it doesn't toggle the control.
- **`src/lib/Skeleton.svelte`** — the shimmer placeholder used behind streamed page data
  (see [`PAGES.md`](PAGES.md)).
- **`src/lib/profile/*`** — the shared profile-page kit that keeps `/me` and `/u/[rsn]`
  pixel-identical: `ProfileBanner` (stone/gold identity header + VP counter),
  `ProfileTabs` (underline tab strip with count chips), `ProfilePanel` (tab-body wrapper
  with the standard padding + fade-in), `RankPanel` (rank badge + composite, next-rank
  progress, weighted component breakdown with a ⓘ data-source/scoring explainer per
  component, gear/CA detail — read-only; /me injects its "Check my rank" form via the
  `actions`/`status` snippets and passes `showSetupTips` so zero-score components tell
  the owner what to set up: Temple for gear/clog, WOM for EHB/time/level, WikiSync for
  CAs), `CollectionPanel` (packs +
  card grid incl. locked/mystery slots), `StatsPanel` (VP/cards/packs/crates/wallet
  mini-stats), and `EmptyState`. If a profile section needs a style change, change the
  component — don't re-style it per page.
