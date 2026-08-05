-- Signature-rank preference on the shared `players` row.
-- Apply by hand in the Supabase SQL editor (no migration runner). Idempotent.
--
-- These two columns are WRITTEN BY THE SITE and READ BY THE BOT (a future Discord
-- `/sync` that tells admins which in-game rank to set):
--   prefer_signature_rank — the member's toggle: show their earned signature (prestige)
--                           rank instead of their composite clan rank.
--   signature_rank        — the signature tier they currently qualify for ('savant' /
--                           'curator' / 'paragon'), or null. Refreshed on each rank check.
--
-- `players.rank` is deliberately LEFT as the composite WOM role, so the current site rank
-- displays and the existing Discord role sync keep working; `/sync` combines rank +
-- prefer_signature_rank + signature_rank to decide what to recommend.

alter table public.players add column if not exists prefer_signature_rank boolean not null default false;
alter table public.players add column if not exists signature_rank text;

-- New columns need a PostgREST schema-cache reload before the API sees them.
notify pgrst, 'reload schema';
