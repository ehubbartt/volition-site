// SERVER-ONLY DuoWolf tile content (name + FAQ + image url + required proof count).
// Lives under $lib/server/ so SvelteKit never bundles it to the client — locked
// tiles must never reach a non-admin's browser (see board/+page.server.ts).
//
// Structure mirrors the event sheet (Not so Lonewolf.xlsx): each FLOOR is a column
// group read top->bottom — start tile, three 3-tile path SECTIONS (floors 1-2 have
// 3 paths, floor 3 has 2) separated by two intermission ("mid") tiles, then a boss.
// `required` = number of APPROVED submissions needed to complete the tile, parsed
// from the leading number in the name (default 1). Edit by hand where the parse is
// wrong (e.g. KC counts). Content keyed onto board node ids via duoNodeRefs().

import { duoNodeRefs, DUO_SECTIONS, type DuoSection } from '$lib/board/config';

export const DUO_WOLF_EVENT_SLUG = 'duo-wolf';

// Tiles that need a before/after proof get a GUIDED two-box submit on the board (a Pre-pic
// box + a Post-pic box). It's purely a UI nudge so players attach the right screenshots —
// the two images are still submitted together as one normal proof. `postRequired` (default
// true) is set false where the FAQ only conditionally needs the post screenshot, so the
// post box is shown + encouraged but never hard-blocks the submission.
export interface DuoPrePic {
	postRequired: boolean;
}

export interface DuoTileContent {
	name: string;
	img: string;
	required: number; // for bosses, this is the HP pool (damage = approved submission quantity)
	faq: string;
	// When set, this tile requires a pre-pic — the board submit modal shows two labelled
	// drop boxes (Pre-pic / Post-pic) instead of one. See DuoPrePic above.
	prePic?: DuoPrePic;
	// Boss-only: a special drop that INSTANTLY clears the boss regardless of HP (a full-HP
	// hit). The string is the player/admin-facing label (e.g. "Mutagen or Pet"). When set,
	// the boss room shows an "Auto-clear" option. Floors 1 & 2 bosses have one; floor 3 doesn't.
	autoClear?: string;
}

interface DuoFloorContent {
	start: DuoTileContent;
	mids: [DuoTileContent, DuoTileContent]; // [midA, midB]
	sections: DuoTileContent[][][]; // [sectionIndex][lane][step]
	boss: DuoTileContent;
}

const FLOORS_CONTENT: DuoFloorContent[] = [
	{
		start: { name: "Any Barrows Drop", img: "https://oldschool.runescape.wiki/images/thumb/Verac%27s_helm_detail.png/120px-Verac%27s_helm_detail.png?1e5bc", required: 1, faq: "Any Barrows armour or weapon drop (No Bolt racks) Preferbly done on W521" },
		mids: [
			{ name: "Full Titans Staff", img: "https://oldschool.runescape.wiki/images/thumb/Eldric_the_Ice_King.png/220px-Eldric_the_Ice_King.png?6bd48", required: 1, faq: "Get 1 Fire Element Staff Crown & 1 Ice Element Staff Crown." },  // intermission after Section A
			{ name: "Any Raids Purple", img: "https://oldschool.runescape.wiki/images/thumb/Monumental_chest_%28teammate%27s%2C_closed%29.png/280px-Monumental_chest_%28teammate%27s%2C_closed%29.png?86e6f", required: 1, faq: "Any Raids Purple. Pic must be taken inside raid.\nAlt-scaling Cox is not allowed (2+13s etc). You are allowed to scale regularly, 2+3s for example." }   // intermission after Section B
		],
		sections: [
			// Section A (3 paths)
			[
				[
					{ name: "Black Mask", img: "https://oldschool.runescape.wiki/images/thumb/Black_mask_detail.png/130px-Black_mask_detail.png?5b902", required: 1, faq: "Get a blackmask from Cave Horrors" },
					{ name: "Wintertodt Rewards", img: "https://oldschool.runescape.wiki/images/thumb/Reward_Cart_%28empty%29.png/250px-Reward_Cart_%28empty%29.png?3c628", required: 25, prePic: { postRequired: true }, faq: "<strong class='prepic'>Pre-pic of available rewards is required</strong> - KC can be done any team-size\n\nIf your starting available rewards are above 0, <strong class='prepic'>your progression submission must also include a final screenshot showing your remaining available rewards.</strong>\nThere is no requirement to do the pulls, just to get the rewards." },
					{ name: "Ecu keys", img: "https://oldschool.runescape.wiki/images/thumb/Ecumenical_key_detail.png/150px-Ecumenical_key_detail.png?0e275", required: 5, faq: "Get 5 Ecu keys from Wilderness. Picture of each key should be made. Should you have keys already drop them prior so you can receive the keys." },
				],
				[
					{ name: "Any Zombie Helm/axe", img: "https://oldschool.runescape.wiki/images/thumb/Broken_zombie_axe_detail.png/120px-Broken_zombie_axe_detail.png?9768e", required: 2, faq: "Any combination of 2 x Zombie Axe or Helm" },
					{ name: "Tempoross Rewards", img: "https://oldschool.runescape.wiki/images/thumb/Tempoross.png/300px-Tempoross.png?12042", required: 45, prePic: { postRequired: true }, faq: "<strong class='prepic'>Pre-pic of available permits is required.</strong> KC can be done in any team size.\n\nIf your starting available rewards are above 0, <strong class='prepic'>your progression submission must also include a final screenshot showing your remaining available rewards.</strong>\nThere is no requirement to do the pulls, just to get the rewards." },
					{ name: "Temotli", img: "https://oldschool.runescape.wiki/images/thumb/Glacial_temotli_detail.png/130px-Glacial_temotli_detail.png?37b7e", required: 1, faq: "Get a Glacial temotli drop." },
				],
				[
					{ name: "Sulphur Blades", img: "https://oldschool.runescape.wiki/images/thumb/Sulphur_blades_detail.png/130px-Sulphur_blades_detail.png?f6d50", required: 1, faq: "Get a Sulphur Blades drop." },
					{ name: "Gotr Rewards", img: "https://oldschool.runescape.wiki/images/thumb/Abyssal_pearls_detail.png/120px-Abyssal_pearls_detail.png?1a047", required: 25, prePic: { postRequired: true }, faq: "<strong class='prepic'>Pre-pic of available rewards is required.</strong> KC can be done in any team size\n\nIf your starting available rewards are above 0, <strong class='prepic'>your progression submission must also include a final screenshot showing your remaining available rewards.</strong>\nThere is no requirement to do the pulls, just to get the rewards." },
					{ name: "Any 2 Tzhaar Drops", img: "https://oldschool.runescape.wiki/images/thumb/TzHaar-Ket_%28level_149%29.png/100px-TzHaar-Ket_%28level_149%29.png?ee1fa", required: 1, faq: "Any two Tzhaar Drops." },
				],
			],
			// Section B (3 paths)
			[
				[
					{ name: "Cudgel", img: "https://oldschool.runescape.wiki/images/thumb/Sarachnis_cudgel_detail.png/150px-Sarachnis_cudgel_detail.png?f9ce8", required: 1, faq: "Get a Cudgel drop." },
					{ name: "Mole", img: "https://oldschool.runescape.wiki/images/thumb/Giant_Mole.png/280px-Giant_Mole.png?3f58a", required: 250, prePic: { postRequired: true }, faq: "Get 250KC of Mole. <strong class='prepic'>Pre-pic of total KC and a Pic after KC is done.</strong>" },
					{ name: "Brimstone Keys", img: "https://oldschool.runescape.wiki/images/thumb/Brimstone_chest.png/280px-Brimstone_chest.png?23463", required: 2, faq: "Get 2 Brimstone keys." },
				],
				[
					{ name: "Any 2 Moons drops", img: "https://oldschool.runescape.wiki/images/thumb/Lunar_Chest_%28closed%29.png/280px-Lunar_Chest_%28closed%29.png?19bbc", required: 1, faq: "Get any 2 Moons drops (Atlatl Darts does not count)" },
					{ name: "Agility Laps", img: "https://oldschool.runescape.wiki/images/thumb/Mark_of_grace_detail.png/150px-Mark_of_grace_detail.png?f58ed", required: 125, prePic: { postRequired: true }, faq: "<strong class='prepic'>Pre-pic of KC & Post pic of KC.</strong>\nAny agility course that yields Mark of Grace." },
					{ name: "Aranea Boots", img: "https://oldschool.runescape.wiki/images/thumb/Aranea_boots_detail.png/150px-Aranea_boots_detail.png?43deb", required: 1, faq: "An Aranea Boots drop." },
				],
				[
					{ name: "Cow Slippers", img: "https://oldschool.runescape.wiki/images/thumb/Brutus.png/280px-Brutus.png?eda9e", required: 2, faq: "2 Cow Slipper drops." },
					{ name: "Herbiboar KC", img: "https://oldschool.runescape.wiki/images/thumb/Herbiboar.png/245px-Herbiboar.png?306ac", required: 115, prePic: { postRequired: true }, faq: "<strong class='prepic'>Pre-pic of Herbiboar KC & Post pic of KC.</strong>" },
					{ name: "Dragon Pickaxe", img: "https://oldschool.runescape.wiki/images/thumb/Dragon_pickaxe_detail.png/140px-Dragon_pickaxe_detail.png?4f4ee", required: 1, faq: "Dragon pickaxe from any PVM source. <strong class='prepic'>If going for broken pickaxe from VM - Pre-pic of rewards must be done.</strong>" },
				],
			],
			// Section C (3 paths)
			[
				[
					{ name: "KQ Head", img: "https://oldschool.runescape.wiki/images/thumb/Kalphite_Queen.png/290px-Kalphite_Queen.png?a4955", required: 1, faq: "A KQ Head, not the tattered one." },
					{ name: "Dragon Axe", img: "https://oldschool.runescape.wiki/images/thumb/Dragon_axe_detail.png/140px-Dragon_axe_detail.png?f429c", required: 1, faq: "A Dragon Axe, from any source." },
					{ name: "Fedora", img: "https://oldschool.runescape.wiki/images/thumb/Fedora_detail.png/140px-Fedora_detail.png?1c5ef", required: 2, faq: "2 Fedoras" },
				],
				[
					{ name: "Vorkath Head", img: "https://oldschool.runescape.wiki/images/thumb/Vorkath.png/280px-Vorkath.png?1ce3f", required: 2, faq: "2 Vorkath Heads. The guaranteed 50KC one does not count. KC number must be shown in the picture." },
					{ name: "Granite Mauls", img: "https://oldschool.runescape.wiki/images/thumb/Granite_maul_detail.png/120px-Granite_maul_detail.png?75031", required: 2, faq: "2 Granite Maul drops" },
					{ name: "Steel Ring", img: "https://oldschool.runescape.wiki/images/thumb/Steel_ring_detail.png/130px-Steel_ring_detail.png?33393", required: 2, faq: "2 Steel Ring drops" },
				],
				[
					{ name: "Any Chaos Druid piece", img: "https://oldschool.runescape.wiki/images/thumb/Elder_Chaos_druid.png/150px-Elder_Chaos_druid.png?559f2", required: 1, faq: "Any chaos druid piece" },
					{ name: "Jad KC", img: "https://oldschool.runescape.wiki/images/thumb/TzTok-Jad.png/280px-TzTok-Jad.png?df681", required: 3, faq: "3 Completions of Fight Caves" },
					{ name: "Mask of Ranul", img: "https://oldschool.runescape.wiki/images/thumb/Mask_of_ranul_detail.png/150px-Mask_of_ranul_detail.png?4f67e", required: 1, faq: "A Mask of Ranul Drop" },
				],
			],
		],
		boss: { name: "Zulrah", img: "https://oldschool.runescape.wiki/images/thumb/Zulrah_%28tanzanite%29.png/249px-Zulrah_%28tanzanite%29.png?fd984", required: 3, autoClear: "Mutagen or Pet", faq: "Any 3 Uniques of the following:\nJar, Magic Fang, Serp Fang, Tanzanite Fang & Uncut Onyx.\n\nMutagen or Pet is insta clear of tile." }
	},
	{
		start: { name: "Mahogany Homes Contracts", img: "https://oldschool.runescape.wiki/images/thumb/Mahogany_Homes_logo.png/280px-Mahogany_Homes_logo.png?79681", required: 25, prePic: { postRequired: true }, faq: "25 Mahogany Homes contracts. <strong class='prepic'>Pre-pic and post-pic of number done required.</strong>" },
		mids: [
			{ name: "Any Raids Purple", img: "https://oldschool.runescape.wiki/images/thumb/Monumental_chest_%28teammate%27s%2C_closed%29.png/280px-Monumental_chest_%28teammate%27s%2C_closed%29.png?86e6f", required: 1, faq: "Any Raids Purple. Pic must be taken inside raid.\nAlt-scaling Cox is not allowed (2+13s etc)." },  // intermission after Section A
			{ name: "Any PVM drop above 1500K", img: "https://oldschool.runescape.wiki/images/thumb/Coins_detail.png/120px-Coins_detail.png?404bc", required: 1, faq: "Any PVM gotten drop with a GE value of above 1500K." }   // intermission after Section B
		],
		sections: [
			// Section A (3 paths)
			[
				[
					{ name: "Ancient Shards (No Skotizo)", img: "https://oldschool.runescape.wiki/images/thumb/Ancient_shard_detail.png/90px-Ancient_shard_detail.png?531d1", required: 2, faq: "2 Ancient Shards. Drops from Skotizo does not count." },
					{ name: "Pharaoh Sceptre", img: "https://oldschool.runescape.wiki/images/thumb/Pharaoh%27s_sceptre_detail.png/150px-Pharaoh%27s_sceptre_detail.png?164e0", required: 1, faq: "1 Pharaoh Sceptre" },
					{ name: "Rune Warhammers or 1 DWH", img: "https://oldschool.runescape.wiki/images/thumb/Dragon_warhammer_detail.png/120px-Dragon_warhammer_detail.png?7f65a", required: 10, faq: "10 Rune Warhammers from anywhere or 1 Dragon Warhammer drop" },
				],
				[
					{ name: "Mossy Keys", img: "https://oldschool.runescape.wiki/images/thumb/Mossy_key_detail.png/150px-Mossy_key_detail.png?cd4e3", required: 10, faq: "10 Mossy key drops. Pre-pic of collection log is recommended, if not 10 separate pictures required." },
					{ name: "Hunter Contracts", img: "https://oldschool.runescape.wiki/images/thumb/Hunters%27_loot_sack_%28master%29_detail.png/130px-Hunters%27_loot_sack_%28master%29_detail.png?8f887", required: 30, prePic: { postRequired: true }, faq: "30 Hunter Contracts. <strong class='prepic'>Pre-pic of number done and post pic.</strong>" },
					{ name: "Dragon Spear", img: "https://oldschool.runescape.wiki/images/thumb/Dragon_spear_detail.png/100px-Dragon_spear_detail.png?cdef4", required: 1, faq: "1 Dragon spear from anywhere." },
				],
				[
					{ name: "Giant Keys", img: "https://oldschool.runescape.wiki/images/thumb/Giant_key_detail.png/130px-Giant_key_detail.png?ca5dd", required: 10, faq: "10 Giant key drops. Pre-pic of collection log is recommended, if not 10 separate pictures required." },
					{ name: "Zombie Keys", img: "https://oldschool.runescape.wiki/images/thumb/Zombie_pirate_key_5_detail.png/150px-Zombie_pirate_key_5_detail.png?d61fc", required: 25, prePic: { postRequired: true }, faq: "25 Zombie key drops. <strong class='prepic'>Take a picture of lootlogger after first kill with codeword shown (pre-pic) and a pic when done (post-pic).</strong>" },
					{ name: "Dragon Sheets", img: "https://oldschool.runescape.wiki/images/thumb/Dragon_metal_sheet_detail.png/130px-Dragon_metal_sheet_detail.png?e2090", required: 3, faq: "3 Dragon Metal Sheets." },
				],
			],
			// Section B (3 paths)
			[
				[
					{ name: "Any 3 Different DK Rings", img: "https://oldschool.runescape.wiki/images/thumb/Dagannoth_Prime.png/200px-Dagannoth_Prime.png?945b1", required: 1, faq: "Any Combination of 3 of Archer Ring, Seers Ring, Warrior Ring & Berserker Ring." },
					{ name: "Venator Shard", img: "https://oldschool.runescape.wiki/images/thumb/Phantom_Muspah_%28shielded%29.png/250px-Phantom_Muspah_%28shielded%29.png?9cf6a", required: 1, faq: "A Venator Shard" },
					{ name: "Chewed Bones", img: "https://oldschool.runescape.wiki/images/thumb/Chewed_bones_detail.png/150px-Chewed_bones_detail.png?26141", required: 2, faq: "2 Chewed Bones drop. Pre-pic of collection log is recommended, but not required." },
				],
				[
					{ name: "Clue Uniques Medium+ NO DUPES", img: "https://oldschool.runescape.wiki/images/thumb/Gilded_armour_set_%28lg%29_equipped.png/130px-Gilded_armour_set_%28lg%29_equipped.png?0b23d", required: 15, prePic: { postRequired: true }, faq: "15 Clue Uniques from Medium Tier of Clues or higher.\n<strong class='prepic'>Pre-pic of banked Casket is required.</strong> If you got stacked clue caskets you wish to keep, make a post-pic of bank with same amount of caskets in it.\nAll 15 Uniques has to be none-dupe with eachother." },
					{ name: "Blood Shard", img: "https://oldschool.runescape.wiki/images/thumb/Blood_shard_detail.png/100px-Blood_shard_detail.png?2fbc7", required: 1, faq: "1 Blood shard drop from killing or pickpocketing." },
					{ name: "Spirit Seed", img: "https://oldschool.runescape.wiki/images/thumb/Spirit_seed_detail.png/150px-Spirit_seed_detail.png?5e2ce", required: 1, faq: "1 Spirit Seed drop." },
				],
				[
					{ name: "Any Wildy Ring", img: "https://oldschool.runescape.wiki/images/thumb/Treasonous_ring_detail.png/200px-Treasonous_ring_detail.png?859ba", required: 1, faq: "Any wilderness ring of: Ring of the Gods, Treasonous Ring & Tyrannical Ring" },
					{ name: "Zenyte Shard", img: "https://oldschool.runescape.wiki/images/thumb/Zenyte_shard_detail.png/80px-Zenyte_shard_detail.png?c5a63", required: 1, faq: "1 Zenyte shard drop" },
					{ name: "Abyssal Whip", img: "https://oldschool.runescape.wiki/images/thumb/Abyssal_whip_detail.png/130px-Abyssal_whip_detail.png?9aee6", required: 1, faq: "An Abyssal whip drop." },
				],
			],
			// Section C (3 paths)
			[
				[
					{ name: "Enhanced teleport seeds", img: "https://oldschool.runescape.wiki/images/thumb/Enhanced_crystal_teleport_seed_detail.png/120px-Enhanced_crystal_teleport_seed_detail.png?84d93", required: 2, faq: "2 Enhanced teleport seeds either from drops or from pickpocketing." },
					{ name: "Burning Claw or 1 Synapse", img: "https://oldschool.runescape.wiki/images/thumb/Tormented_synapse_detail.png/120px-Tormented_synapse_detail.png?27153", required: 2, faq: "2 Burning Claw drops or 1 Synapse drop." },
					{ name: "DHW or Tome of Earth", img: "https://oldschool.runescape.wiki/images/thumb/Dragon_hunter_wand_detail.png/130px-Dragon_hunter_wand_detail.png?a3e16", required: 1, faq: "Dragon Hunter Wand or the Tome of Earth." },
				],
				[
					{ name: "Smoke Battlestaff", img: "https://oldschool.runescape.wiki/images/thumb/Smoke_battlestaff_detail_animated.gif/180px-Smoke_battlestaff_detail_animated.gif?d80ae", required: 1, faq: "1 Smoke Battlestaff" },
					{ name: "Any Seed CG", img: "https://oldschool.runescape.wiki/images/thumb/Crystal_armour_seed_detail.png/120px-Crystal_armour_seed_detail.png?fa149", required: 2, faq: "Any 2 CG Seeds of: Armour Seed, Weapon Seed, Enhanced Weapon Seed." },
					{ name: "Any champ scroll", img: "https://oldschool.runescape.wiki/images/thumb/Hobgoblin_champion_scroll_detail.png/130px-Hobgoblin_champion_scroll_detail.png?37397", required: 1, faq: "Any champion scroll drop.\nIf you already have the scroll you are getting, a textline will be shown in chat and that is what you should use as proof." },
				],
				[
					{ name: "Antler Guard", img: "https://oldschool.runescape.wiki/images/thumb/Antler_guard_detail.png/130px-Antler_guard_detail.png?a40bf", required: 1, faq: "1 Antler Guard Drop" },
					{ name: "Full Wildy Shield", img: "https://oldschool.runescape.wiki/images/thumb/Malediction_ward_detail.png/130px-Malediction_ward_detail.png?c708e", required: 1, faq: "All 3 Pieces of either Malediction or Odium Shield. Must be all 3 of the same shield." },
					{ name: "Any Superior Drop", img: "https://oldschool.runescape.wiki/images/thumb/Imbued_heart_detail.png/150px-Imbued_heart_detail.png?be01a", required: 1, faq: "Any Superior Drop from a superior monster.\nDust Battlestaff, Mist Battlestaff, Imbued Heart or Eternal Gem." },
				],
			],
		],
		boss: { name: "God Wars", img: "https://oldschool.runescape.wiki/images/thumb/God_Wars_Dungeon_Entrance.png/300px-God_Wars_Dungeon_Entrance.png?8b0f5", required: 6, autoClear: "Any item from a minion", faq: "Any 6 Uniques from God Wars Bosses.\nGod sword shards does not Count.\nAny drop from a minion will autocomplete the tile. (F.x. Bandos tassets from a minion)." }
	},
	{
		start: { name: "Any Raids Purple", img: "https://oldschool.runescape.wiki/images/thumb/Monumental_chest_%28teammate%27s%2C_closed%29.png/280px-Monumental_chest_%28teammate%27s%2C_closed%29.png?86e6f", required: 1, faq: "Any Raids Purple. Pic must be taken inside raid.\nAlt-scaling Cox is not allowed (2+13s etc)." },
		mids: [
			{ name: "Any Corp Unique", img: "https://oldschool.runescape.wiki/images/thumb/Corporeal_Beast.png/270px-Corporeal_Beast.png?52ebb", required: 1, faq: "Any corp collection logdrop excluding Pet." },  // intermission after Section A
			{ name: "Any Raids Purple", img: "https://oldschool.runescape.wiki/images/thumb/Monumental_chest_%28teammate%27s%2C_closed%29.png/280px-Monumental_chest_%28teammate%27s%2C_closed%29.png?86e6f", required: 1, faq: "Any Raids Purple. Pic must be taken inside raid.\nAlt-scaling Cox is not allowed (2+13s etc)." }   // intermission after Section B
		],
		sections: [
			// Section A (2 paths)
			[
				[
					{ name: "Venator Shards", img: "https://oldschool.runescape.wiki/images/thumb/Phantom_Muspah_%28melee%29.png/250px-Phantom_Muspah_%28melee%29.png?4b33c", required: 2, faq: "2 Venator Shards." },
					{ name: "Any Zalcano Unique", img: "https://oldschool.runescape.wiki/images/thumb/Zalcano.png/200px-Zalcano.png?6244d", required: 1, faq: "Any Zalcano Unique of:\nCrystal Tool Seeds, Zalcano Shard & uncut Onyx\nPet does not count." },
					{ name: "Unsired", img: "https://oldschool.runescape.wiki/images/thumb/Abyssal_Sire.png/280px-Abyssal_Sire.png?d2205", required: 2, faq: "2 Unsired drops." },
				],
				[
					{ name: "Cerb Any 2 Uniques", img: "https://oldschool.runescape.wiki/images/thumb/Cerberus.png/280px-Cerberus.png?47f4c", required: 1, faq: "Any two drops from Cerbs drop table excluding the Pet & Key Master teleport scroll." },
					{ name: "Any Big Fish", img: "https://oldschool.runescape.wiki/images/thumb/Big_shark_detail.png/130px-Big_shark_detail.png?e3794", required: 1, faq: "Any Big Fish" },
					{ name: "Revenant Totems worth 10M", img: "https://oldschool.runescape.wiki/images/thumb/Ancient_totem_detail.png/150px-Ancient_totem_detail.png?63bac", required: 1, faq: "Totem drops from Revenants totaling 10M value." },
				],
			],
			// Section B (2 paths)
			[
				[
					{ name: "Godsword from Scratch", img: "https://oldschool.runescape.wiki/images/thumb/Commander_Zilyana.png/250px-Commander_Zilyana.png?c5eaa", required: 1, faq: "All 3 God sword shards & Any Hilt" },
					{ name: "Any Voidwaker Piece", img: "https://oldschool.runescape.wiki/images/thumb/Voidwaker_detail.png/150px-Voidwaker_detail.png?01835", required: 1, faq: "Any voidwaker piece" },
					{ name: "Any Jar", img: "https://oldschool.runescape.wiki/images/thumb/Jar_of_chemicals_detail.png/90px-Jar_of_chemicals_detail.png?7bdc6", required: 1, faq: "Any Jar.\nShould you want to do Skotizo you are not allowed to use pre-banked Skotizo Totem. <strong class='prepic'>Pre-pic and post-pic must be done for Skotizo.</strong>" },
				],
				[
					{ name: "Any rev weapon", img: "https://oldschool.runescape.wiki/images/thumb/Craw%27s_bow_%28u%29_detail.png/180px-Craw%27s_bow_%28u%29_detail.png?bf1fd", required: 1, faq: "Any rev weapon.\nCraw's Bow, Viggora's Chainmace & Thammaron's Sceptre" },
					{ name: "Colo Uniques", img: "https://oldschool.runescape.wiki/images/thumb/Sol_Heredit_%28sitting%29.png/250px-Sol_Heredit_%28sitting%29.png?aa6d1", required: 3, faq: "Any 3 of the following drops from colosseum:\nSunfire Helm, Body Legs. Echo Crystal & Ralos." },
					{ name: "Any Oathplate", img: "https://oldschool.runescape.wiki/images/thumb/Yama.png/280px-Yama.png?7653a", required: 1, faq: "Any of Oathplate Helm, Body or Legs. Contracts of Oathplate acquisition are not allowed to be used." },
				],
			],
			// Section C (2 paths)
			[
				[
					{ name: "Tourmaline Core", img: "https://oldschool.runescape.wiki/images/thumb/Dawn.png/300px-Dawn.png?8b8ea", required: 1, faq: "A Tourmaline core drop." },
					{ name: "Any Nex drop", img: "https://oldschool.runescape.wiki/images/thumb/Nex.png/270px-Nex.png?2a1b3", required: 1, faq: "Any Nex Unique of:\nTorva Helm, Body, Legs, Vambraces, Ancient hilt or Nihil Horn." },
					{ name: "Doom Drop", img: "https://oldschool.runescape.wiki/images/thumb/Doom_of_Mokhaiotl.png/277px-Doom_of_Mokhaiotl.png?e5edb", required: 1, faq: "Any doom drop of:\nMokhiatl Cloth, Avernic Treads, Eye of Ayak." },
				],
				[
					{ name: "Nally piece or Neck", img: "https://oldschool.runescape.wiki/images/thumb/Araxxor_%28enraged%29.png/280px-Araxxor_%28enraged%29.png?418cf", required: 2, faq: "Any 2 Noxious Halberd pieces or 1 Araxyte Fang" },
					{ name: "Claw or 2 x Leather or 1 Leather + 1 Bring", img: "https://oldschool.runescape.wiki/images/thumb/Alchemical_Hydra_%28electric%29.png/230px-Alchemical_Hydra_%28electric%29.png?925dd", required: 1, faq: "Any combination of:\n1 Hydra Claw\n2 Hydra Leather\n1 Hydra leather & 1 Full Brimstone Ring" },
					{ name: "PNM Drop", img: "https://oldschool.runescape.wiki/images/thumb/The_Nightmare.png/250px-The_Nightmare.png?0128a", required: 1, faq: "Any Nightmare drops excluding:\nSlepey Tablet, Parasitic Egg & Pet." },
				],
			],
		],
		boss: { name: "Desert Treasure 2", img: "https://oldschool.runescape.wiki/images/thumb/The_Whisperer.png/120px-The_Whisperer.png?aedab", required: 2, faq: "Any 2 drops of either:\nFull Ring (gold ring 1, gold ring 2 & Vestige)\nAny SRA piece\nAny Virtus\n\nMeaning:\n1 Full Ring + 1 SRA piece will clear this tile\nor\n1 SRA piece + 1 Virtus\nor 2 Virtus pieces." }
	}
];

function sectionIndex(section: DuoSection): number {
	return DUO_SECTIONS.indexOf(section);
}

// The hardcoded DEFAULTS, built once from FLOORS_CONTENT. These are the fallback whenever a
// tile has no admin override row (see vs_duo_tiles / duoTileStore.ts).
const DEFAULT_DUO_TILES: Map<string, DuoTileContent> = (() => {
	const map = new Map<string, DuoTileContent>();
	for (const ref of duoNodeRefs()) {
		const floor = FLOORS_CONTENT[ref.floor - 1];
		if (!floor) throw new Error(`DuoWolf: no content for floor ${ref.floor}`);
		let t: DuoTileContent | undefined;
		switch (ref.kind) {
			case 'start':
				t = floor.start;
				break;
			case 'boss':
				t = floor.boss;
				break;
			case 'mid':
				t = floor.mids[ref.midIndex ?? 0];
				break;
			case 'path':
				t = floor.sections[sectionIndex(ref.section!)]?.[ref.lane!]?.[ref.step!];
				break;
		}
		if (!t) throw new Error(`DuoWolf: missing tile content for node ${ref.id}`);
		map.set(ref.id, t);
	}
	return map;
})();

// The LIVE tile map the getters read. Starts as the defaults and is atomically swapped by
// applyDuoTileOverrides() whenever duoTileStore.ts refreshes from the DB. Callers in async
// contexts should `await ensureDuoTilesFresh()` (duoTileStore.ts) before reading so the
// sync getters below return the admin-edited content.
let activeTiles: Map<string, DuoTileContent> = DEFAULT_DUO_TILES;

// Set of every valid board node id — STRUCTURAL (from the board config), so it's stable
// regardless of content overrides.
export const DUO_TILE_IDS: ReadonlySet<string> = new Set(DEFAULT_DUO_TILES.keys());

// A row from vs_duo_tiles (admin tile override). Mirrors the table columns.
export interface DuoTileOverrideRow {
	node_id: string;
	name: string;
	img: string;
	required: number;
	faq: string;
	pre_pic: boolean;
	pre_pic_post_required: boolean;
	auto_clear: string | null;
}

// Rebuild the live tile map = defaults with each override row fully replacing its tile.
// Atomic reference swap so concurrent sync readers never see a half-built map.
export function applyDuoTileOverrides(rows: DuoTileOverrideRow[]): void {
	if (!rows.length) {
		activeTiles = DEFAULT_DUO_TILES;
		return;
	}
	const next = new Map<string, DuoTileContent>(DEFAULT_DUO_TILES);
	for (const row of rows) {
		if (!DUO_TILE_IDS.has(row.node_id)) continue;
		next.set(row.node_id, {
			name: row.name,
			img: row.img,
			required: Math.max(1, Math.floor(Number(row.required) || 1)),
			faq: row.faq ?? '',
			prePic: row.pre_pic ? { postRequired: !!row.pre_pic_post_required } : undefined,
			autoClear: row.auto_clear || undefined
		});
	}
	activeTiles = next;
}

// The hardcoded default for a tile (ignores overrides) — used by the admin editor's
// "reset to default" path so it can show what reverting would restore.
export function getDefaultDuoTile(id: string): DuoTileContent | null {
	return DEFAULT_DUO_TILES.get(id) ?? null;
}

export function getDuoTileName(id: string): string | null {
	return activeTiles.get(id)?.name ?? null;
}

export function getDuoTileFaq(id: string): string | null {
	return activeTiles.get(id)?.faq ?? null;
}

export function getDuoTileImg(id: string): string | null {
	return activeTiles.get(id)?.img || null;
}

export function getDuoTileRequired(id: string): number {
	return activeTiles.get(id)?.required ?? 1;
}

// Boss-only auto-clear label (a full-HP instant clear, e.g. "Mutagen or Pet"); null if
// the tile has none (all non-bosses + floor-3 boss).
export function getDuoTileAutoClear(id: string): string | null {
	return activeTiles.get(id)?.autoClear ?? null;
}

// Pre-pic config for a tile (null if it doesn't require a before/after proof). When set,
// the board submit modal renders two labelled drop boxes (Pre-pic + Post-pic).
export function getDuoTilePrePic(id: string): DuoPrePic | null {
	return activeTiles.get(id)?.prePic ?? null;
}
