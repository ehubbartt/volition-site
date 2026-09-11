-- Stamp the BEFORE-screenshot flag onto a game that is already dealt.
--
-- The flag lives on the tile, and a live game holds its own COPY of every tile taken at
-- deal time — so updating the checked-in planned list does nothing for a board already in
-- play. The admin page has a button for this ("Re-apply from the planned list"); this file
-- is the same operation in SQL, for when the button is not to hand.
--
-- It matches by name with punctuation and case ignored, and rewrites the deck, the pool and
-- the custom list IN PLACE. `with ordinality ... order by ord` is load-bearing: the deck's
-- ORDER is the deal, and reordering it would silently move every tile on the board.
--
-- Set the slug in the two places it appears. Safe to run twice.
--
-- NOT VERIFIED BY EXECUTION. The button calls `applyPreShots`, which is drilled
-- (`npm run drill:connect4:preshot`, including that the deck order and the pieces are
-- untouched). This file is the same operation expressed in SQL for when the button is not
-- reachable, and no database this repo's tooling can reach was available to run it
-- against. PREFER THE BUTTON. If you do run this, run the check at the bottom after it.

with names (n, note) as (
	values
		('Bear Feet', null),
		('Any Elegant Clothing Piece', null),
		('Any Kourend Scarf', null),
		('Demon Feet', null),
		('Any Cavalier', null),
		('Ancient D''hide Piece', null),
		('Frog Slippers', null),
		('Any Boater', null),
		('Armadyl D''hide Piece', null),
		('Mole Slippers', null),
		('Any God Cloak', null),
		('Bandos D''hide Piece', null),
		('Any Beret', null),
		('Any Headband', null),
		('Guthix D''hide Piece', null),
		('Any Bob Shirt', null),
		('Any Kourend Banner', null),
		('Saradomin D''hide Piece', null),
		('Ham Joint or Rain Bow', null),
		('Any Mitre', null),
		('Zamorak D''hide Piece', null),
		('Imp Mask or Goblin Mask', null),
		('Climbing Boots (g)', null),
		('Any Dragon Mask', null),
		('Any Cane', null),
		('Holy Sandals', null),
		('Any Demon Mask', null),
		('Ranger Boots', null),
		('Any Kourend Hood', null),
		('Spiked Manacles', null),
		('Wizard Boots', null),
		('Granite Pieces', null),
		('Any Crozier', null),
		('Any Stole', null),
		('Abyssal Head', 'precheck on banked unsireds'),
		('Bludgeon Piece', null),
		('Bryophyta''s Essence', null),
		('Hill Giant Club', null),
		('Big Harpoonfish', null),
		('Tome of Water', null),
		('Pyromancer Pieces', null),
		('Tome of Fire', null),
		('Colossal Wyrm Course', null),
		('Rooftop Course Laps', null),
		('Brimhaven Agility Tickets', null),
		('Gold Nuggets', null),
		('Stardust', null),
		('MTA Alchemy Points', null),
		('MTA Graveyard Points', null),
		('MTA Enchant Points', null),
		('MTA Telegrab Points', null),
		('LMS Victories', null),
		('Pest Control Points', null),
		('Tithe Farm Points', null),
		('Mermaid Tears', null),
		('Dragon Pickaxe Broken', null),
		('Ape Atoll Laps', null),
		('Barbarian Assault Points/High Gambles', null),
		('Chompy Birds', null),
		('Giants Foundry Points', null),
		('Abyssal Dyes', null),
		('Hallowed Marks', null),
		('Mahog Homes Contracts', null),
		('Hunter Rumors', null),
		('Mixology Points', null),
		('Unidentified Minerals', null)
),
keys as (select lower(regexp_replace(n, '[^a-zA-Z0-9]', '', 'g')) as k, note from names),
marked as (
	select
		e.id,
		e.structure,
		(
			select coalesce(jsonb_agg(
				case when k.k is null then t
				     else t || jsonb_build_object('pre_shot', true)
				          || case when k.note is null then '{}'::jsonb
				                  else jsonb_build_object('pre_note', k.note) end
				end order by ord), '[]'::jsonb)
			from jsonb_array_elements(e.structure->'connect4'->'deck') with ordinality as d(t, ord)
			left join keys k on k.k = lower(regexp_replace(d.t->>'item_name', '[^a-zA-Z0-9]', '', 'g'))
		) as deck,
		(
			select coalesce(jsonb_agg(
				case when k.k is null then t
				     else t || jsonb_build_object('pre_shot', true)
				          || case when k.note is null then '{}'::jsonb
				                  else jsonb_build_object('pre_note', k.note) end
				end order by ord), '[]'::jsonb)
			from jsonb_array_elements(e.structure->'connect4'->'pool') with ordinality as p(t, ord)
			left join keys k on k.k = lower(regexp_replace(p.t->>'item_name', '[^a-zA-Z0-9]', '', 'g'))
		) as pool,
		(
			select coalesce(jsonb_agg(
				case when k.k is null then t
				     else t || jsonb_build_object('pre_shot', true)
				          || case when k.note is null then '{}'::jsonb
				                  else jsonb_build_object('pre_note', k.note) end
				end order by ord), '[]'::jsonb)
			from jsonb_array_elements(e.structure->'connect4'->'custom') with ordinality as c(t, ord)
			left join keys k on k.k = lower(regexp_replace(c.t->>'item_name', '[^a-zA-Z0-9]', '', 'g'))
		) as custom
	from vs_events e
	where e.slug = 'volition-vs-ironclad'
)
update vs_events e
set structure = jsonb_set(
	jsonb_set(
		jsonb_set(m.structure, '{connect4,deck}', m.deck),
		'{connect4,pool}', m.pool
	),
	'{connect4,custom}', m.custom
)
from marked m
where e.id = m.id;

-- Check it: how many cells now ask for a before screenshot (expect 124 on the full board).
select count(*) filter (where (t->>'pre_shot')::boolean) as cells_needing_a_before_shot,
       count(*) as cells
from vs_events e, jsonb_array_elements(e.structure->'connect4'->'deck') t
where e.slug = 'volition-vs-ironclad';
