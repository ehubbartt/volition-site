# Site onboarding (Version B — site-owned join)

A new-member onboarding flow that lives on the site, entered via a unique link the
Discord bot DMs. **Version B** reproduces the Discord join phase on the site (verify →
profile → intro → setup → rewards → in-game handoff); **Version A** (a later,
lighter "post-join tour") is the *same* flow with the starting steps trimmed.

> Status: **test-only**. Reachable only through a minted token (the bot's
> `/onboard-test-a|b` admin commands). The live Discord join ticket is **untouched**.

## Shape

- **Step registry** — `src/lib/onboarding/steps.ts` (client-safe). Each variant is an
  ordered `StepId[]`. Version B is the full list; **Version A is a subset** —
  cutting B → A is literally deleting `verify` / `profile` / `join` from the `a`
  array. Steps are self-contained (no step depends on another beyond what's persisted
  on the token row), so removing one never breaks the rest.
- **Session = one token row** — `vs_onboarding_tokens` (`db/scripts/onboarding_tokens.sql`,
  shared DB, hand-applied). Resumable, not consume-once: reopening the link reloads the
  in-progress session, gated by `expires_at` and by the signed-in user's `discord_id`
  matching the row. Progress = `current_step` + `completed_steps` + a `data` scratch blob.
- **Server module** — `src/lib/server/onboarding.ts`: `loadOnboarding` (bind on first
  open), `completeStep` / `gotoStep`, `mintOnboardingToken`, and the step side effects
  that aren't just a reused primitive — `verifyRsn` (WiseOldMan 2000+/150+ gate),
  `postIntroToDiscord` (bridge), `grantOnboardingRewards` (free crate VP roll + white pack).
- **Route** — `src/routes/welcome/[token]/` (`+page.server.ts` load + per-step actions;
  `+page.svelte` the stepper). Signed-out visitors round-trip through Discord OAuth via
  a `next` param (login/callback honour a same-origin `vs_oauth_next` cookie).

## Reused primitives (no logic duplicated)

- Rank check → `rankData.fetchPlayerRankInputs` + `rankScoring.scorePlayer` + `vs_rank_sim`
  cache + `setPlayerRank` (lean copy of the `/me` `checkRank` action).
- Dink → `dinkTokens.getOrCreateToken` + `configUrlFor`. Temple → the `/temple-guide` page.
- White pack → resolve `white%` in `vs_card_packs` + `grantUserPack` (grants directly, as
  Version B members aren't clan members yet — `ensureWelcomePack`'s gate wouldn't pass).
- Loot crate → `lootcrate.rollLoot` (VP-only gift) + `grantPlayerVp`.

## Site → bot bridge (Version B Discord-side effects)

`src/lib/server/botBridge.ts` gained two message types the bot handles:
- `post_intro` — the 5-field introduction, posted into the intro channel in the same
  format the Discord intro modal produces.
- `onboard_verified` — grant the verified role + set nickname = RSN. **Rank + the actual
  in-game invite still ride the existing WOM listener / `/syncuser`** (unchanged).

## Testing

The bot's `/onboard-test-a|b [@user]` admin commands mint a token (default: the caller)
and DM the `/welcome/<token>` link. Nothing here is wired into a production join path.
