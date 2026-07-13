-- Add the "elemental" pack flag to vs_card_packs.
-- Run in the Supabase SQL editor (no migration runner in this repo).
--
-- Elemental packs are NOT purchasable with VP or the wallet (GP). They are
-- gifted to members for participating in events (granted via /admin/cards →
-- Grant, which writes vs_user_packs). On the Gamba page they only appear when
-- the player actually holds a copy, and the only action offered is the free
-- "open from inventory" — the VP / wallet buy buttons are suppressed and the
-- server-side `open` / `openWithGp` actions refuse them.
--
-- The companion "teaser" (coming soon) flag already exists on this table; this
-- script only adds `elemental`. NOT NULL DEFAULT false so existing packs are
-- plain purchasable packs.

alter table vs_card_packs
  add column if not exists elemental boolean not null default false;

-- VERIFY — list any packs currently flagged elemental.
select id, name, elemental, released
from vs_card_packs
where elemental
order by name;
