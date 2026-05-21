import type { BingoTier, BingoTile } from '$lib/bingo/tiles';
import { TIER_BY_KEY } from '$lib/bingo/tiles';

// Tile content lives here under $lib/server/ so SvelteKit never bundles it
// into the client. The /bingo route is responsible for redacting names of
// tiles the viewer isn't allowed to see before returning data to the page.

const ROWS: Array<[string, string, string, string]> = [
	['10 Molch Pearls', 'New mole gem bag upgrade thingy', 'God sword: Any hilt', 'Cox Unique'],
	['Pharohs sceptre', 'Scurrius Spine', 'Any Dag ring', 'Any Jar'],
	['gnome restaurant unique', 'Beef Pet', 'Chaos ele pet', 'Yama Horn'],
	['Shark paint', 'Fedora', 'Amulet of the Damned', 'Nightmare unique / Phosanis'],
	['moon loop half from bone mine', 'Huey Unique', 'Oathplate Shard Drop', 'Tob Unique'],
	['burn an oomlie wrap', 'KQ Head', 'Any CG seed', 'Nex Unique'],
	['cook a snake from mm2', 'Any Bopa', 'Royal titans staff Piece', 'Colo Sunfire Drop'],
	['Mine 521 Stardust', 'Steel Ring', 'Wildy Ring', 'Glowy hole'],
	['pickpocket a elite clue from a hero', 'Zenyte', 'Any Rev Totem', 'Toa Unique'],
	['25 Con laps wildy', 'Mask of Ranul', 'Elder Chaos Robes', 'Gold Ring Drop'],
	['piece of pyromancer outfit', 'Sarachnis Pristine silk', 'Champion scroll', 'Brutus Slippers'],
	[
		'Score 521 giant foundry total points',
		'Black Pickaxe',
		'Any Odium AND male shard',
		'Spirit Shield'
	]
];

const BONUS: string[] = [
	'Sub 500k gear',
	'Any Pet',
	'Solo',
	'Nightmare time',
	'Silly Hat and Boots',
	'CG',
	'Colo',
	'Fight Cave sub 100k Gear / invent',
	'Sub 500k Gear Expert',
	'Kill Vard with only Dragon Scim',
	'Sara brew from grubby chest',
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
// Tiles with no entry simply hide the "How to complete" card in the modal.
// Lives under $lib/server/ so future-tile details never get sent to the
// browser before that row releases.
const TILE_DETAILS: Record<string, string> = {
	// Add entries here. Example:
	// 'r1-skilling': 'Get 10 **Molch Pearls** while aerial fishing at Molch Isle.\n\n- Snap a clipped screenshot of the inventory.\n- Stacked pearls from earlier trips count.',
	// 'r1-hard': 'Any unique drop from **Chambers of Xeric**. Loot-screen screenshot.',
	// 'b1': 'Inventory + worn gear screenshot in any boss-capable setup under 500k GE value.'
};

export function getTileDetails(tileId: string): string | null {
	return TILE_DETAILS[tileId] ?? null;
}
