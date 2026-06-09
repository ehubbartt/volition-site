-- Give every site user one free "White Pack".
-- Run in the Supabase SQL editor. Tables: vs_users (site users),
-- vs_card_packs (pack catalog), vs_user_packs (per-user unopened packs,
-- unique on (user_id, pack_id)).
--
-- This is an ADDITIVE grant: each user gets +1 of the white pack (a brand-new
-- vs_user_packs row, or +1 to their existing one). Re-running it stacks another
-- pack onto everyone — run it ONCE. (For a "set to exactly 1" version instead,
-- see the note at the bottom.)

-- ── Step 1: PREVIEW — confirm this resolves to the pack you mean, and how many
-- users will be granted. Run this on its own first.
select
  (select count(*) from vs_users)                       as users_to_grant,
  p.id   as white_pack_id,
  p.name as white_pack_name
from vs_card_packs p
where p.name ilike 'white%'        -- adjust to your exact pack name if needed
order by p.created_at
limit 1;

-- ── Step 2: GRANT — give everyone one white pack.
with white_pack as (
  select id
  from vs_card_packs
  where name ilike 'white%'         -- keep this in sync with Step 1
  order by created_at
  limit 1
)
insert into vs_user_packs (id, user_id, pack_id, quantity, updated_at)
select gen_random_uuid(), u.id, w.id, 1, now()
from vs_users u
cross join white_pack w            -- 0 rows if no pack matched → nothing happens
on conflict (user_id, pack_id) do update
  set quantity   = vs_user_packs.quantity + 1,
      updated_at = now();

-- ── Step 3: VERIFY — how many users now hold the white pack.
select count(*) as users_with_white_pack
from vs_user_packs up
join vs_card_packs p on p.id = up.pack_id
where p.name ilike 'white%';

-- ── Alternative: ENSURE exactly one (idempotent — safe to re-run, never stacks).
-- Replace the ON CONFLICT clause in Step 2 with:
--   on conflict (user_id, pack_id) do update
--     set quantity = greatest(vs_user_packs.quantity, 1), updated_at = now();
