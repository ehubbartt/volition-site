import type { BingoTier, BingoTile } from '$lib/bingo/tiles';
import { TIER_BY_KEY } from '$lib/bingo/tiles';

// Tile content lives here under $lib/server/ so SvelteKit never bundles it
// into the client. The /bingo route is responsible for redacting names of
// tiles the viewer isn't allowed to see before returning data to the page.

const ROWS: Array<[string, string, string, string]> = [
	['1 Molch Pearls', 'New mole gem bag upgrade thingy', 'Arenea Boots', 'Toa Unique'],
	['5 Gold Satuettes', 'Scurrius Spine', 'Any Dag ring', 'Any Jar'],
	['Gnome Restaurant Unique', 'Beef Pet', 'Chaos ele pet', 'Yama Horn'],
	['Shark paint', 'Fedora', 'Amulet of the Damned', 'Nightmare unique / Phosanis'],
	['Moon Loop half from bone mine', 'Huey Unique', 'Oathplate Shard Drop', 'Tob Unique'],
	['burn an oomlie wrap', 'KQ Head', 'Any CG seed', 'Nex Unique'],
	['cook a snake from mm2', 'Any Bopa', 'Royal titans staff Piece', 'Colo Unique'],
	['Mine 521 Stardust', 'Steel Ring', 'Wildy Ring', 'Glowy hole'],
	['pickpocket a elite clue from a hero', 'Zenyte', 'Any Rev Totem', 'Cox Unique'],
	['25 Con laps wildy', 'Mask of Ranul', 'Elder Chaos Robes', 'Gold Ring Drop'],
	['piece of pyromancer outfit', 'Sarachnis Pristine silk', 'Champion scroll', 'God sword: Any hilt'],
	[
		'Score 521 giant foundry total points',
		'Black Pickaxe',
		'Any Odium AND male shard',
		'Spirit Shield'
	]
];

const BONUS: string[] = [
	'Complete Moa',
	'Kill Giant mole: Maple sb and addy arrows',
	'Solo Yama No demonbane',
	'Nightmare Dragon mace and Ibans only',
	'Silly Hat and Boots',
	'Cg only tier 1 weapons',
	'Complete Waves 1-11 with only hunter sunlight cb',
	'Fight Cave Weapon only',
	'One Style Cox',
	'Kill Vard with only Dragon Scim',
	'Brutus Slippers',
	'Build a demonic throne'
];

const TIER_ORDER: BingoTier[] = ['skilling', 'easy', 'medium', 'hard'];

export const BINGO_TILES: BingoTile[] = (() => {
	const out: BingoTile[] = [];
	for (let r = 0; r < ROWS.length; r++) {
		const row = r + 1;
		ROWS[r].forEach((name, i) => {
			const tier = TIER_ORDER[i];
			out.push({
				id: `r${row}-${tier}`,
				name,
				tier,
				row,
				points: TIER_BY_KEY[tier].points
			});
		});
	}
	for (let b = 0; b < BONUS.length; b++) {
		const row = b + 1;
		out.push({
			id: `b${row}`,
			name: BONUS[b],
			tier: 'bonus',
			row,
			points: TIER_BY_KEY.bonus.points
		});
	}
	return out;
})();

export const BINGO_TILE_BY_ID: Record<string, BingoTile> = Object.fromEntries(
	BINGO_TILES.map((t) => [t.id, t])
);

// ============================================================================
// PER-TILE "HOW TO COMPLETE" / FAQ
// ============================================================================
// Markdown is supported (headings, lists, **bold**, *italic*, `inline code`,
// [links](https://example.com), blockquotes).
// Tile IDs follow the pattern:
//   r{row}-{tier}  for the main grid    (e.g. 'r1-skilling', 'r5-hard', 'r12-medium')
//   b{row}         for the bonus column (e.g. 'b1', 'b7', 'b12')
// Tile rows + tiers come from the ROWS array above (row 1 is the top).
// Any tile not listed in TILE_DETAILS falls back to DEFAULT_TILE_DETAILS.
// Lives under $lib/server/ so future-tile details never get sent to the
// browser before that row releases.

const DEFAULT_TILE_DETAILS =
	'Screenshot of the new collection log or the untradeable loot notification.';

const TILE_DETAILS: Record<string, string> = {
	// Skilling-tier overrides
	'r2-skilling': 'Screenshot of 5 gold statuettes from pyramid plunder in inventory.',
	'r6-skilling': 'Screenshot of Oomlie wrap in inventory.',
	'r7-skilling': 'Screenshot of Stuffed snake in inventory.',
	'r8-skilling': 'Screenshot of 521 stardust in inventory.',
	'r9-skilling': 'Screenshot of the untradeable loot notification.',
	'r10-skilling': 'Screenshot of 25 wilderness agility tickets in inventory.',
	'r12-skilling': 'Screenshot of a 150 score sword in giants foundry.',

	// Bonus-tile rules
	'b1': 'Complete Moa.',
	'b2': 'Kill Giant Mole using only Maple shortbow and adamant arrows.',
	'b3': 'Solo Yama with no demonbane weapons.',
	'b4': 'Kill Nightmare using only Dragon mace and Iban\'s staff.',
	'b5': 'Wear a silly hat and silly boots — admins decide what counts.',
	'b6': 'Complete Corrupted Gauntlet using only tier 1 weapons.',
	'b7': 'Complete Fortis Colosseum waves 1–11 using only the hunter sunlight crossbow.',
	'b8': 'Complete the Fight Caves using only the weapon (no other gear).',
	'b9': 'Complete Chambers of Xeric using only one combat style.',
	'b10': 'Kill Vardorvis using only a Dragon Scimitar.',
	'b11': 'Obtain Brutus Slippers as a drop.',
	'b12': 'Build a Demonic throne in your POH.'
};

export function getTileDetails(tileId: string): string | null {
	return TILE_DETAILS[tileId] ?? DEFAULT_TILE_DETAILS;
}
