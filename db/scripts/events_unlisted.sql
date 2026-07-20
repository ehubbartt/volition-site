-- Unlisted events + the permanent Dink Self-Test event. Apply by hand in the
-- Supabase SQL editor (no migration runner). Safe to re-run.
--
-- `unlisted` hides an event from the public /events list, the home-page stats,
-- and the bot's event announcements, while keeping it fully functional and
-- reachable by direct link. Built for utility events like the Dink self-test;
-- reusable for anything else that shouldn't advertise itself.
--
-- ⚠ Apply BEFORE deploying the site build that filters on this column (the
-- listing queries reference it), and before merging the bot's unlisted filter.

alter table vs_events add column if not exists unlisted boolean not null default false;

-- ── Retire the old Dink Self-Test FAKE event ────────────────────────────────
-- The connection self-test was previously a real, permanently-open `dink-self-test`
-- vs_events row that /dink-check auto-enrolled every visitor into (a bare
-- vs_event_signups row) so its Bones tile lit up their allowlist. That fake-event
-- machinery (visit-driven enroll/un-enroll/prune) is superseded by declarative
-- per-member pins in `vs_dink_manual_items` (see dink_manual_items.sql + branch 4 of
-- active_tiles.sql; /dink-check now pins Bones directly). Remove the old rows —
-- idempotent, safe to re-run, no-op once gone. Signups first, then the event; its
-- tiles + tracked items cascade with the event delete.
delete from vs_event_signups
where event_id in (select id from vs_events where slug = 'dink-self-test');

delete from vs_events where slug = 'dink-self-test';

-- PostgREST caches the schema; without this the new column 404s until restart.
notify pgrst, 'reload schema';
