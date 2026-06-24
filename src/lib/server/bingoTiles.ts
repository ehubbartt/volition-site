import type { BingoTier, BingoTile } from '$lib/bingo/tiles';
import { TIER_BY_KEY } from '$lib/bingo/tiles';

// Tile content lives here under $lib/server/ so SvelteKit never bundles it
// into the client. The /bingo route is responsible for redacting names of
// tiles the viewer isn't allowed to see before returning data to the page.

const ROWS: Array<[string, string, string, string]> = [
	['1 Molch Pearls', 'Immaculate Mole Skin', 'Arenea Boots', 'Toa Unique'],
	['5 Gold Statuettes', 'Scurrius Spine', 'Any Dag ring', 'Any Jar'],
	['Gnome Restaurant Unique', 'Beef Pet', 'Chaos ele pet', 'Yama Horn'],
	['Shark paint', 'Fedora', 'Amulet of the Damned', 'Nightmare unique / Phosanis'],
	['Moon Loop half from bone mine', 'Huey Unique', 'Oathplate Shard Drop', 'Tob Unique'],
	['Burn an oomlie wrap', 'KQ Head', 'Any CG seed', 'Nex Unique'],
	['Sorceress\'s Garden', 'Any Boppa', 'Royal titans staff Piece', 'Colo Unique'],
	['Mine 521 Stardust', 'Steel Ring', 'Wildy Ring', 'Glowy hole'],
	['Pickpocket a elite clue from a hero', 'Zenyte', 'Any Rev Totem', 'Cox Unique'],
	['25 wildy laps', 'Mask of Ranul', 'Elder Chaos Robes', 'Gold Ring Drop'],
	['Gain 521 charges to a milk bucket', 'Sarachnis Pristine silk', 'Champion scroll', 'God sword: Any hilt'],
	[
		'Giants foundry',
		'Black Pickaxe',
		'Any Odium AND male shard',
		'Spirit Shield'
	]
];

const BONUS: string[] = [
	'Moa',
	'Giant mole',
	'Yama',
	'Nightmare',
	'Tob',
	'CG',
	'Colosseum',
	'Fight Caves',
	'Cox',
	'Vardorvis',
	'Calvar\'ion',
	'Demonic throne'
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

export const DEFAULT_TILE_DETAILS =
	'Screenshot of the new collection log or the untradeable loot notification.';

const TILE_DETAILS: Record<string, string> = {
	// Skilling-tier overrides
	'r1-hard': 'Must be a purple in your name',
	'r2-skilling': 'Screenshot of 5 gold statuettes from pyramid plunder in inventory.',
	'r6-skilling': 'Screenshot of Oomlie wrap in inventory.',
	'r7-skilling': 'Pick one of each seasonal Sq\'irk fruits in the Sorceress\'s Garden',
	'r-7-medium': 'Screenshot of the new collection log or the untradeable loot notification from Earthbound tecpatl, Glacial temotli, Sulphur blades, Dual macas, or Torag\'s hammers.',
	'r8-skilling': 'Screenshot of 521 stardust in inventory.',
	'r9-skilling': 'Screenshot of the untradeable loot notification.',
	'r10-skilling': 'Screenshot of 25 wilderness agility tickets in inventory.',
	'r11-skilling': 'Pre-screenshot of milk bucket charges and post with at least 521 more charges.',
	'r12-skilling': 'Screenshot of a 150 score sword in giants foundry.',

	// Bonus-tile rules
	'b1': `Complete a **Tombs of Amascut** raid with **3-4 players** escorting a butcher through every room.

**Cows** (every player except one):
- Wear the full **5-piece cow outfit** from Django in Draynor.
- Any weapons; any gear in non-cow slots is allowed.

**Butcher** (the remaining player):
- Wear **only** an apron, a chef's hat, and a meat cleaver — nothing else equipped.
- May only heal with **cooked beef or T-Bone Steak** during the raid.
- **Must not die.**

**Rules:**
- The butcher enters every room first — they cannot wait outside while the cows clear.
- The challenge is complete when the cows successfully carry the butcher through the entire raid.

**Proof (both required):**
1. Inventory screenshot with the **party hub visible** so every player's inventory can be verified.
2. Scoreboard screenshot showing the **death count**.`,
	'b2': 'Kill Giant Mole using only Maple shortbow and adamant arrows. No armour or gear.',
	'b3': 'Solo Yama with no demonbane weapons or demonbane spells. (no shadow)',
	'b4': 'Kill Phosani\'s Nightmare using a Dragon mace, Iban\'s staff, and any darts as your only weapons. Any armour and other gear is allowed.',
	'b5': `Complete a **4-man Theatre of Blood** where each player takes a colored Power Ranger role with a fixed uniform and combat style for the entire raid.

**Roles, uniforms & allowed styles:**
- **Red Ranger** — melee role · **melee only**
  - Red d'hide body + chaps and a **Dragon med helm**.
- **Green Ranger** — ranged role · **melee + ranged**
  - Green d'hide body + chaps and an **Adamant med helm**.
- **Blue Ranger** — magic role · **melee + magic**
  - Blue d'hide body + chaps and a **Mithril med helm**.
- **Black Ranger** — flex role · **any combat style**
  - Black d'hide body + chaps and a **Black med helm**.

**Gear rules:**
- The uniform above is **required** for the body, legs, and helm slots.
- **No gear switching** mid-raid — the set you enter with is the set you wear the entire raid (2-h weapons unequipping your shield is allowed).
- **Weapon swaps are the only exception** (so Green can swap melee weapon ↔ bow, etc.).
- Other slots (boots, gloves, cape, ammy, ring) are unrestricted as long as they fit the role's allowed styles.

**Proof:**
- Screenshot at Verzik's death / the reward chest with the **party hub visible** so every player's uniform and color can be verified.`,
	'b6': 'Complete Corrupted Gauntlet using only tier 1 weapons. Screenshot quickly before you get teleported out of the arena.',
	'b7': `Complete **Fortis Colosseum waves 1–12** using only gear obtainable from the **Varlamore region**.

**Item rules:**
- Every item you bring — weapons, armour, ammo, food, potions, runes — must be **fully obtainable within Varlamore**.
- **No items from Doom of Mokhaiotl** are allowed.
- You must be on the **Arceuus spellbook** for the entire run.

**Proof:**
- Screenshot of your inventory + worn gear and the colosseum completion / wave 12 screen.`,
	'b8': 'Complete the Fight Caves using only a weapon (no other gear).',
	'b9': `Complete a **3-man Chambers of Xeric** where every player commits to a single combat style for the entire raid.

**Before entering:**
- Each player chooses **melee, ranged, or magic** and locks in that style for the whole raid.

**During the raid:**
- Use only gear and weapons of your chosen style. Bringing any off-style gear **disqualifies the run**.
- **Thralls** are allowed, but only the thrall variant matching your chosen style.
- You may use non combat spells regardless of your chosen style.

**Proof:**
- Screenshot inside **Olm's chamber** after the Great Olm has been defeated with party hub visible.`,
	'b10': 'Kill Vardorvis using only a Dragon Scimitar. No armour is allowed.',
	'b11': `Kill **Calvar'ion** using a **Bone club** with your **entire inventory filled with bones**.

**Bone gear discount:**
- You may also wear other bone gear (Skeletal armour, Dragonbone necklace, etc.).
- For **each piece of extra bone gear** worn, you may bring **one fewer bone** in your inventory for the kill.

**Proof:**
- Screenshot of the kill with your inventory and worn gear visible.`,
	'b12': 'Build a Demonic throne in your POH.'
};

export function getTileDetails(tileId: string): string | null {
	return TILE_DETAILS[tileId] ?? DEFAULT_TILE_DETAILS;
}
