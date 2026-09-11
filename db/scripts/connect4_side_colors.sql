-- Connect Four — repaint the two sides
--
-- A game's side colours are STORED, not derived: `createConnect4` stamps
-- SIDE_COLORS (`#ef4444` red for side 1, `#eab308` yellow for side 2) into
-- `vs_events.structure -> 'connect4' -> 'sides'` at creation, and everything that
-- draws the game reads them back from there — the 2D discs, the 3D discs, the tile
-- rail, the score pills, the hover card and the admin credit buttons. So repainting a
-- side is this one write; there is no code change and nothing to redeploy.
--
-- Nothing else keys off the colour. Sides keep their numbers, their teams and their
-- pieces, so this is safe to run on a game that is already live and mid-play.
--
-- Written for `volition-vs-ironclad`: Volition yellow, IronClad red (the reverse of
-- how the game was dealt). Matching is BY NAME, not by position, so it does not matter
-- which side number each clan holds, and re-running it changes nothing.
--
-- NOT VERIFIED BY EXECUTION: this environment has no route to the database (port 5432
-- is blocked and the Management API token is not valid), so the statements below have
-- been written and reviewed but not run. Run the SELECT first and read the result.

-- 1. Before: what the two sides look like now.
select s->>'side' as side, s->>'name' as name, s->>'color' as color
from vs_events e,
     lateral jsonb_array_elements(e.structure->'connect4'->'sides') s
where e.slug = 'volition-vs-ironclad'
order by 1;

-- 2. The repaint. Volition -> yellow, IronClad -> red; any other side is left alone.
update vs_events e
set structure = jsonb_set(
        e.structure,
        '{connect4,sides}',
        (
            select jsonb_agg(
                       case
                           when s->>'name' ilike '%volition%'
                               then jsonb_set(s, '{color}', '"#eab308"'::jsonb)
                           when s->>'name' ilike '%ironclad%'
                               then jsonb_set(s, '{color}', '"#ef4444"'::jsonb)
                           else s
                       end
                       order by (s->>'side')::int
                   )
            from jsonb_array_elements(e.structure->'connect4'->'sides') s
        )
    )
where e.slug = 'volition-vs-ironclad'
  and jsonb_typeof(e.structure->'connect4'->'sides') = 'array';

-- 3. After: expect Volition #eab308 and IronClad #ef4444.
select s->>'side' as side, s->>'name' as name, s->>'color' as color
from vs_events e,
     lateral jsonb_array_elements(e.structure->'connect4'->'sides') s
where e.slug = 'volition-vs-ironclad'
order by 1;

-- A board already open repaints on its next load, not on the live poll: the 2D discs
-- read the colour reactively, but the 3D board bakes one material per side when its
-- scene is built (`Connect4Board3D.svelte`). Refresh the page to see it.

-- 4. FALLBACK — only if step 1 shows side names that contain neither "volition" nor
-- "ironclad" (the statement above would then leave both sides untouched). This swaps
-- the two colours between whatever the sides are called, so it is NOT idempotent:
-- run it exactly once, and re-run step 3 to confirm.
--
-- update vs_events e
-- set structure = jsonb_set(
--         e.structure,
--         '{connect4,sides}',
--         (
--             select jsonb_agg(
--                        jsonb_set(
--                            s,
--                            '{color}',
--                            to_jsonb(
--                                case when s->>'color' = '#ef4444' then '#eab308'
--                                     when s->>'color' = '#eab308' then '#ef4444'
--                                     else s->>'color' end
--                            )
--                        )
--                        order by (s->>'side')::int
--                    )
--             from jsonb_array_elements(e.structure->'connect4'->'sides') s
--         )
--     )
-- where e.slug = 'volition-vs-ironclad'
--   and jsonb_typeof(e.structure->'connect4'->'sides') = 'array';
