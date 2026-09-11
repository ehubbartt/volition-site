# Frontend conventions & shared UI

Svelte conventions and the reusable UI pieces to build on. Update this doc when you add a
broadly-shared component or change a convention. For page data-loading, see
[`PAGES.md`](PAGES.md).

## Conventions

- **Svelte 5 runes** (`$state`, `$derived`, `$props`, `{#snippet}`/`{@render}`).
- **Form actions** return `{ ok: true }` or `fail(status, { error })`; forms use
  `use:enhance` for optimistic UI. Pending state via `src/lib/busy.svelte.ts` (`createBusy()`).
- **A pre-filled form needs `update({ reset: false })`.** The bare `use:enhance` RESETS the
  form on success, and a reset restores each control to its `value` **attribute** — which
  Svelte never writes, because `value={…}` is set as a DOM *property*. So every pre-filled
  box on a settings-style form empties itself the moment you press Save, which reads as the
  save having wiped the thing you were editing. Bare `use:enhance` is right only where
  clearing the form is the point (a "create" or "add" form) or where the row it lives in
  disappears on success. Pair it with a server that treats a **blank** numeric field as
  "unchanged" rather than `0` — `Number('')` is `0` and `isFinite(0)` is `true`, so the
  usual guard does not catch it — and with a visible confirmation, so a save that worked
  never looks the same as one that ate your input.
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

- **`src/lib/wikiImage.ts`** — the single source of truth for OSRS Wiki image URLs. URLs go
  through **`Special:FilePath`**, not `/images/<File>.png`: MediaWiki keeps files in
  hash-bucketed subdirectories, so the flat path only resolved for the ones that happened to
  be served that way. FilePath is a strict superset of it and takes `?width=`, so
  `wikiThumbUrl()` needs no knowledge of the `/thumb/` layout either.
  File names are **case-sensitive past the first letter**, and our item names come from the
  OSRS item database in a different case (`Staff_of_the_Dead.png`, not
  `Staff_of_the_dead.png`). There is no case-insensitive lookup, so the typed helpers
  (`itemImageUrl`, `skillImageUrl`, `monsterImageUrl` and `caTierImageUrl`) return a **list
  of candidate spellings** (as given, then the wiki's title case, hyphens included) which
  `<WikiImage>` walks. Measured over the boss-drop catalogue, that took blank icons from
  61/345 to 5.
  `monsterImageUrl` adds two more passes for drop sources, whose names rarely match an NPC
  file: `MONSTER_IMAGE_ALIASES` maps raids, reward chests and form-qualified bosses to an
  image that exists (`Zulrah` → `Zulrah (serpentine)`, `Lunar chest` → `Blue Moon`), and a
  **trailing `(...)` qualifier is stripped** as a further candidate, which covers the whole
  `Vorkath (Post-quest)` / `Scurrius (MVP)` / `Rewards Chest (Fortis Colosseum) (Wave 7)`
  family without an entry each. Over the 76 distinct sources in the Connect Four tile pool
  that took resolution from 45/76 to 76/76. `itemIconUrl` (`$lib/osrsItems`), `skillIconUrl`
  (`$lib/ehp`) and the CA icon fns (`$lib/ca`) are thin re-exports — don't fork new copies.
- **`src/routes/api/wiki-image/+server.ts`** — **icons are served by us, not hotlinked.**
  A 600-tile board watched by two clans is a few hundred browsers each firing a burst at the
  wiki's Cloudflare front, which drops a share of them and leaves tiles blank. This endpoint
  fetches each file **once**, keeps it in memory (LRU, 1500 entries, 24h) and serves it with
  a year's `immutable` cache lifetime, so the wiki sees one origin and the steady state is
  no wiki traffic at all. Concurrent misses for the same file share one fetch, and a name
  the wiki has no file for is negative-cached for ten minutes. It is **not** an open proxy:
  `?name=` goes through `wikiImageSources` and `?file=` must be a bare wiki file name — the
  URL fetched is always built here, on the wiki's host.
- **`src/lib/WikiImage.svelte`** — an `<img>` with the hotlink incantation baked in
  (`referrerpolicy="no-referrer"` + `use:retryImage`); renders nothing for an empty `src`.
  `src` takes a url **or a list of candidates**, and each is rewritten through the proxy
  above by `viaProxy` with the direct wiki url kept behind it — so every existing caller got
  the cache without changing, and a problem with the proxy degrades to the old behaviour
  instead of blanking a board. `e2e/wiki-image-proxy.spec.ts` asserts a page loads **zero**
  images from `runescape.wiki`.
  `retryImage` (`$lib/imageRetry`) handles the two failures that blank a tile and that
  `onerror` cannot tell apart, since it carries no status: it tries every candidate spelling
  once (clearing a case mismatch within a frame), then backs off and retries the whole list
  (clearing a wiki-side throttle), and hides the element only once both are exhausted. Use it
  on any raw hotlinked `<img>` (e.g. the rank gear grid) that isn't already a `WikiImage`.
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
