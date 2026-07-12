# Auth, sessions, roles & audit

How members sign in, how roles are resolved, how the ban gate works, and how admin actions
are logged. Update this doc when you change the auth flow, the role model, or audit capture.

## Login & sessions

Discord OAuth via `arctic`. `src/routes/auth/discord/login` sets a state cookie and
redirects; `.../callback` exchanges the code, upserts `vs_users`, creates a `vs_sessions`
row, and sets the `vs_session` HTTP-only cookie. First-time users go to `/onboarding`.
`src/lib/server/auth.ts` owns session create/read/destroy (and a ~60s in-memory session
cache, invalidated on logout and on any non-GET from that session). Logout is **POST-only**
(a GET logout is CSRF/prefetch-triggerable).

## Roles (`src/lib/server/auth.ts`)

Roles are the union of **env allow-lists** and **DB grants**:

- `isSuperAdmin` — `SUPER_ADMIN_DISCORD_IDS` only (owners; highest tier; can use the generic
  table editor and bot-config editor). Intentionally **env-only** — never grantable from the
  UI, so a compromised admin can't escalate to owner.
- `isAdmin` — `ADMIN_DISCORD_IDS` ∪ super admins ∪ `vs_admin_roles` grants (role `admin`).
- `isCardTester` — `CARD_TESTER_DISCORD_IDS` ∪ `vs_admin_roles` grants (role `card_tester`).
  Full card/pack CRUD; independent of admin.
- `isCardAdmin` = `isAdmin || isCardTester` (view-level access to the cards area).

**DB-backed grants:** `vs_admin_roles` is managed by owners at `/admin/admins`.
`src/lib/server/adminRoles.ts` keeps a ~30s in-memory cache of those grants, refreshed once
per request in the hook, so `isAdmin()`/`isCardTester()` stay **synchronous** at their ~50
call sites. Fail-open for env roles, fail-closed for DB grants on a DB error.

The root `+layout.server.ts` exposes `isAdmin`/`isCardTester`/`isSuperAdmin` flags for the
UX-only page guards; the real authorization boundary is the endpoint role re-check (see
[`PAGES.md`](PAGES.md), Admin).

**View-as (super admins only).** A super admin can preview the site as a lower role via
the fixed switcher pill (bottom-left): plain admin, member, or non-clan-member ('guest').
Mechanics: a `vs_view_as` cookie set by `POST /admin/view-as`; `hooks.server.ts` applies it
to `locals.user` ONLY when the real session user is a super admin (checked before the
override, after the staging lock so the preview can't lock you out of staging), so it can
strictly reduce privileges. Every role check honors it — `isAdmin`/`isSuperAdmin`/
`isCardTester` short-circuit on `user.view_as`, and `isClanMember(user)` answers false for
'guest' — so guards, endpoints, actions, and nav all behave as the previewed role. The
switcher is a NATIVE form on purpose (full reload wipes the client swr cache, so higher-role
payloads can't leak into the preview); `locals.realSuperAdmin` carries the real identity so
you can always switch back.

## Ban gate

Banned users (the bot's `bans` table, keyed by Discord id) are redirected to `/banned` on
every authenticated request. The read is a synchronous lookup against a TTL-cached bans
table (`src/lib/server/bansCache.ts`, ~30s, paginated past the 1000-row cap, fail-open) so it
costs zero round-trips; a new ban takes effect within the TTL on machines other than the one
that issued it (ban/unban actions force an immediate local refresh). `locals.ban` is
populated for every authenticated request; only the redirect is skipped for static assets
(a real extension check, not "contains a dot", so route params with dots aren't exempted).

## Admin audit log (`src/lib/server/audit.ts`)

Admin form POSTs are logged automatically from the hook: who (user + roles), where
(route/path/action), the form payload (files reduced to metadata, long fields truncated),
the response status, and — for table edits — the prior row state so the viewer can show a
before→after diff. Stored in `vs_audit_log`.
