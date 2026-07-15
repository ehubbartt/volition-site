-- Per-token Dink loot allowlist — one row per (active dink token × active item tile of
-- that token's member). The dink-proxy Worker reads this view BY NAME when serving
-- /config/<token>, injecting ONLY the member's own active items into their
-- lootItemAllowlist. Previously it injected the clan-wide union
-- (vs_active_tracked_items), so an item lingered in everyone's allowlist until NOBODY
-- in the clan tracked it — this makes the allowlist track the member's own boards.
--
-- Token → member: dink_tokens.discord_id → vs_users.discord_id. Member → active tiles:
-- lower(rsn) against vs_active_player_tiles (open-event signups + LOCKED personal
-- boards; tiles with an approved completion are already excluded by that view, so
-- completing a tile drops its item here automatically).
--
-- Apply by hand in the Supabase SQL editor (idempotent), AFTER active_tiles.sql.
-- The Worker change that consumes this ships separately in the dink-proxy repo;
-- until it's deployed, this view is inert.

drop view if exists vs_dink_token_items;

create view vs_dink_token_items as
  select distinct t.token, pt.item_id, pt.item_name, pt.match_type
  from dink_tokens t
  join vs_users u on u.discord_id = t.discord_id
  join vs_active_player_tiles pt on lower(pt.rsn) = lower(u.rsn)
  where t.revoked_at is null
    and pt.type = 'item';

-- Same RLS posture as the sibling proxy views (see active_tiles.sql / enable_rls.sql):
-- plain views run with the OWNER's privileges and would leak through table RLS
-- without security_invoker; the proxy reads via service_role.
alter view vs_dink_token_items set (security_invoker = true);
revoke select on vs_dink_token_items from anon, authenticated;
