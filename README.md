# volition-site

Standalone SvelteKit site for the Volition OSRS clan. MVP scope: account creation via Discord OAuth, event list, per-event signup pool, in-site duo invites/accepts, per-clan stats.

## Stack

- SvelteKit (Svelte 5, runes) + `@sveltejs/adapter-node`
- Supabase (shared project with `voli-disc-bot`; new tables prefixed `vs_`)
- Discord OAuth via `arctic`
- Server-side sessions in `vs_sessions` (cookie holds the row id)
- Reuses the bot's Supabase **anon key** (RLS is off in this project). All Supabase calls live in `src/lib/server/*`, so the key never ships to the browser.
- Plain Svelte scoped CSS + a small `app.css` of design tokens

## First-time setup

1. **Install deps**
   ```sh
   npm install
   ```

2. **Run the SQL migration** in the Supabase SQL Editor:
   - `db/migrations/0001_init.sql` — creates the `vs_*` tables
   - `db/functions/vs_accept_invite.sql` — atomic accept-invite RPC

3. **Create a Discord application** at <https://discord.com/developers/applications>
   - OAuth2 → Redirects: add `http://localhost:5173/auth/discord/callback` (and your prod URL when you have one)
   - Copy the Client ID + Client Secret into `.env`

4. **Copy `.env.example` to `.env`** and fill in the values.

5. **Boot the dev server**
   ```sh
   npm run dev
   ```

## Routes

| Path                      | Notes                                                   |
| ------------------------- | ------------------------------------------------------- |
| `/`                       | Public landing. Logged-in users redirect to `/events`.  |
| `/auth/discord/login`     | Starts OAuth flow.                                      |
| `/auth/discord/callback`  | OAuth callback — creates/links user, sets session.      |
| `/auth/logout` (POST)     | Clears session.                                         |
| `/onboarding`             | Collects RSN + clan after first login.                  |
| `/events`                 | Lists active events.                                    |
| `/events/[slug]`          | Event detail — join, player pool, invites, team, stats. |
| `/me`                     | Edit profile.                                           |
| `/admin/events`           | Create/manage events. Gated by `ADMIN_DISCORD_IDS`.     |

## Schema notes

All site tables are prefixed `vs_` so they don't collide with the bot's tables (`players`, `tile_event_*`, etc.) in the shared Supabase project.

The accept-invite flow goes through the `vs_accept_invite` Postgres function so it runs atomically with row locks — this prevents two simultaneous accepts from putting one player on two teams.

## Deploy (Fly.io)

```sh
flyctl launch        # first time only — accept the existing Dockerfile/fly.toml
flyctl secrets set SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… \
                   DISCORD_CLIENT_ID=… DISCORD_CLIENT_SECRET=… \
                   PUBLIC_SITE_URL=https://volition-site.fly.dev \
                   ADMIN_DISCORD_IDS=1234567890,…
flyctl deploy
```

After deploy, register the production redirect URI (`${PUBLIC_SITE_URL}/auth/discord/callback`) in the Discord OAuth app.
