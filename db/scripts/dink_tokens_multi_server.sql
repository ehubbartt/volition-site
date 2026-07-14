-- dink_tokens — per-member multi-server flag.
--
-- Members who use Dink with OTHER Discord servers can't take the standard config
-- (its minLootValue of 1 fires their other webhooks on every drop). The flag lives
-- on the token row because the proxy already reads dink_tokens to validate tokens —
-- it picks the config variant in the same query: multi_server tokens are served a
-- HIGH minLootValue and rely on the tracked-item allowlist instead.
--
-- Set from the /dink-check page ("I use Dink with multiple Discord servers");
-- carried across token rotations by the site.
--
-- Apply by hand in the Supabase SQL editor (no migration runner). Idempotent.

alter table public.dink_tokens
	add column if not exists multi_server boolean not null default false;
