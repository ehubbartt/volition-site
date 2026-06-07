// SERVER-ONLY DuoWolf tile content (names + FAQ). Lives under $lib/server/ so
// SvelteKit never bundles it to the client — locked tiles must never reach a
// non-admin's browser (see board/+page.server.ts, which redacts before sending).
//
// Structure mirrors the event sheet (Not so Lonewolf.xlsx): each FLOOR is a
// column group read top->bottom. A floor = start tile, three 3-tile path
// SECTIONS (floors 1-2 have 3 parallel paths, floor 3 has 2) separated by two
// intermission ("mid") tiles everyone does, then a boss. Content is keyed onto
// the board node ids from board/config.ts via duoNodeRefs(), so the grid shape
// stays in sync with board/topology.ts. FAQ is markdown-able (rendered server-side).

import { duoNodeRefs, DUO_SECTIONS, type DuoSection } from '$lib/board/config';

export const DUO_WOLF_EVENT_SLUG = 'duo-wolf';

export interface DuoTileContent {
	name: string;
	faq: string;
}

interface DuoFloorContent {
	start: DuoTileContent;
	mids: [DuoTileContent, DuoTileContent]; // [midA, midB]
	sections: DuoTileContent[][][]; // [sectionIndex][lane][step]
	boss: DuoTileContent;
}

const FLOORS_CONTENT: DuoFloorContent[] = [
	{
		start: { name: "Any Barrows Drop", faq: "Any Barrows armour or weapon drop (No Bolt racks) Preferbly done on W521" },
		mids: [
			{ name: "Full Titans Staff", faq: "Get 1 Fire Element Staff Crown & 1 Ice Element Staff Crown." },  // intermission after Section A
			{ name: "Any Raids Purple", faq: "Any Raids Purple. Pic must be taken inside raid.\nAlt-scaling Cox is not allowed (2+13s etc). You are allowed to scale regularly, 2+3s for example." }   // intermission after Section B
		],
		sections: [
			// Section A (3 paths)
			[
				[
					{ name: "1 x Black Mask", faq: "Get a blackmask from Cave Horrors" },
					{ name: "25 Wintertodt Rewards", faq: "Pre-pic of available rewards are required - KC can be done any team-size" },
					{ name: "5 Ecu keys", faq: "Get 5 Ecu keys from Wilderness. Picture of each key should be made. Should you have keys already drop them prior so you can receive the keys." },
				],
				[
					{ name: "2 x Any Zombie Helm/axe", faq: "Any combination of 2 x Zombie Axe or Helm" },
					{ name: "45 Tempoross Rewards", faq: "Pre-pick of available permits. KC can be done in any team size." },
					{ name: "1 x Temotli", faq: "Get a Glacial temotli drop." },
				],
				[
					{ name: "1 x Sulphur Blades", faq: "Get a Sulphur Blades drop." },
					{ name: "25 Gotr Rewards", faq: "Pre-pic of available rewards. KC can be done in any team size" },
					{ name: "Any 2 Tzhaar Drops", faq: "Any two Tzhaar Drops." },
				],
			],
			// Section B (3 paths)
			[
				[
					{ name: "1 x Cudgel", faq: "Get a Cudgel drop." },
					{ name: "250KC Mole", faq: "Get 250KC of Mole. Pre-pic of total KC and a Pic after KC is done." },
					{ name: "2 Brimstone Keys", faq: "Get 2 Brimstone keys." },
				],
				[
					{ name: "Any 2 Moons drops", faq: "Get any 2 Moons drops (Atlatl Darts does not count)" },
					{ name: "125 Agility Laps", faq: "Pre-pic of KC & Post pic of KC.\nAny agility course that yields Mark of Grace." },
					{ name: "1 x Aranea Boots", faq: "An Aranea Boots drop." },
				],
				[
					{ name: "2 x Cow Slippers", faq: "2 Cow Slipper drops." },
					{ name: "115 Herbiboar KC", faq: "Pre-pic of Herbiboar KC & Post pic of KC." },
					{ name: "1 x Dragon Pickaxe", faq: "Dragon pickaxe from any PVM source. If going for broken pickaxe from VM - Prepic of rewards must be done." },
				],
			],
			// Section C (3 paths)
			[
				[
					{ name: "KQ Head", faq: "A KQ Head, not the tattered one." },
					{ name: "1 x Dragon Axe", faq: "A Dragon Axe, from any source." },
					{ name: "2 x Fedora", faq: "2 Fedoras" },
				],
				[
					{ name: "2 x Vorkath Head", faq: "2 Vorkath Heads. The guaranteed 50KC one does not count. KC number must be shown in the picture." },
					{ name: "2 Granite Mauls", faq: "2 Granite Maul drops" },
					{ name: "2 x Steel Ring", faq: "2 Steel Ring drops" },
				],
				[
					{ name: "Any Chaos Druid piece", faq: "Any chaos druid piece" },
					{ name: "3 Jad KC", faq: "3 Completions of Fight Caves" },
					{ name: "Mask of Ranul", faq: "A Mask of Ranul Drop" },
				],
			],
		],
		boss: { name: "Zulrah", faq: "Any 3 Uniques of the following:\nJar, Magic Fang, Serp Fang, Tanzanite Fang & Uncut Onyx.\n\nMutagen or Pet is insta clear of tile." }
	},
	{
		start: { name: "25 Mahogany Homes Contracts", faq: "25 Mahogany Homes contracts. Pre-pic and post-pic of number done required" },
		mids: [
			{ name: "Any Raids Purple", faq: "Any Raids Purple. Pic must be taken inside raid.\nAlt-scaling Cox is not allowed (2+13s etc)." },  // intermission after Section A
			{ name: "Any PVM drop above 1500K", faq: "Any PVM gotten drop with a GE value of above 1500K." }   // intermission after Section B
		],
		sections: [
			// Section A (3 paths)
			[
				[
					{ name: "2 Ancient Shards (No Skotizo)", faq: "2 Ancient Shards. Drops from Skotizo does not count." },
					{ name: "1x Pharaoh Sceptre", faq: "1 Pharaoh Sceptre" },
					{ name: "10 Rune Warhammers or 1 DWH", faq: "10 Rune Warhammers from anywhere or 1 Dragon Warhammer drop" },
				],
				[
					{ name: "10 Mossy Keys", faq: "10 Mossy key drops. Pre-pic of collection log is recommended, if not 10 separate pictures required." },
					{ name: "30 Hunter Contracts", faq: "30 Hunter Contracts. Pre-pic of number done and post pic." },
					{ name: "1 x Dragon Spear", faq: "1 Dragon spear from anywhere." },
				],
				[
					{ name: "10 Giant Keys", faq: "10 Giant key drops. Pre-pic of collection log is recommended, if not 10 separate pictures required." },
					{ name: "25 x Zombie Keys", faq: "25 Zombie key drops. Pre-pic of collection log is recommended, if not 10 separate pictures required." },
					{ name: "3 x Dragon Sheets", faq: "3 Dragon Metal Sheets." },
				],
			],
			// Section B (3 paths)
			[
				[
					{ name: "Any 3 Different DK Rings", faq: "Any Combination of 3 of Archer Ring, Seers Ring, Warrior Ring & Berserker Ring." },
					{ name: "1 Venator Shard", faq: "A Venator Shard" },
					{ name: "2 x Chewed Bones", faq: "2 Chewed Bones drop. Pre-pic of collection log is recommended, but not required." },
				],
				[
					{ name: "15 Clue Uniques Medium+ NO DUPES", faq: "15 Clue Uniques from Medium Tier of Clues or higher.\nPre-pic of banked Casket is required. If you got stacked clue caskets you wish to keep, make a post-pic of bank with same amount of caskets in it.\nAll 15 Uniques has to be none-dupe with eachother." },
					{ name: "1 Blood Shard", faq: "1 Blood shard drop from killing or pickpocketing." },
					{ name: "1 x Spirit Seed", faq: "1 Spirit Seed drop." },
				],
				[
					{ name: "Any Wildy Ring", faq: "Any wilderness ring of: Ring of the Gods, Treasonous Ring & Tyrannical Ring" },
					{ name: "1 Zenyte Shard", faq: "1 Zenyte shard drop" },
					{ name: "1 x Abyssal Whip", faq: "An Abyssal whip drop." },
				],
			],
			// Section C (3 paths)
			[
				[
					{ name: "2 Enhanced teleport seeds", faq: "2 Enhanced teleport seeds either from drops or from pickpocketing." },
					{ name: "2 Burning Claw or 1 Synapse", faq: "2 Burning Claw drops or 1 Synapse drop." },
					{ name: "DHW or Tome of Earth", faq: "Dragon Hunter Wand or the Tome of Earth." },
				],
				[
					{ name: "1 x Smoke Battlestaff", faq: "1 Smoke Battlestaff" },
					{ name: "2 x Any Seed CG", faq: "Any 2 CG Seeds of: Armour Seed, Weapon Seed, Enhanced Weapon Seed." },
					{ name: "Any champ scroll", faq: "Any champion scroll drop.\nIf you already have the scroll you are getting, a textline will be shown in chat and that is what you should use as proof." },
				],
				[
					{ name: "1 x Antler Guard", faq: "1 Antler Guard Drop" },
					{ name: "1 Full Wildy Shield", faq: "All 3 Pieces of either Malediction or Odium Shield. Must be all 3 of the same shield." },
					{ name: "1 x Any Superior Drop", faq: "Any Superior Drop from a superior monster.\nDust Battlestaff, Mist Battlestaff, Imbued Heart or Eternal Gem." },
				],
			],
		],
		boss: { name: "God Wars", faq: "Any 6 Uniques from God Wars Bosses.\nGod sword shards does not Count.\nAny drop from a minion will autocomplete the tile. (F.x. Bandos tassets from a minion)." }
	},
	{
		start: { name: "Any Raids Purple", faq: "Any Raids Purple. Pic must be taken inside raid.\nAlt-scaling Cox is not allowed (2+13s etc)." },
		mids: [
			{ name: "Any Corp Unique", faq: "Any corp collection logdrop excluding Pet." },  // intermission after Section A
			{ name: "Any Raids Purple", faq: "Any Raids Purple. Pic must be taken inside raid.\nAlt-scaling Cox is not allowed (2+13s etc)." }   // intermission after Section B
		],
		sections: [
			// Section A (2 paths)
			[
				[
					{ name: "2 Venator Shards", faq: "2 Venator Shards." },
					{ name: "Any Zalcano Unique", faq: "Any Zalcano Unique of:\nCrystal Tool Seeds, Zalcano Shard & uncut Onyx\nPet does not count." },
					{ name: "2 x Unsired", faq: "2 Unsired drops." },
				],
				[
					{ name: "Cerb Any 2 Uniques", faq: "Any two drops from Cerbs drop table excluding the Pet & Key Master teleport scroll." },
					{ name: "Any Big Fish", faq: "Any Big Fish" },
					{ name: "Revenant Totems worth 10M", faq: "Totem drops from Revenants totaling 10M value." },
				],
			],
			// Section B (2 paths)
			[
				[
					{ name: "Godsword from Scratch", faq: "All 3 God sword shards & Any Hilt" },
					{ name: "Any Voidwaker Piece", faq: "Any voidwaker piece" },
					{ name: "Any Jar", faq: "Any Jar.\nShould you want to do Skotizo you are not allowed to use pre-banked Skotizo Totem. Pre-pic and post-pic must be done for Skotizo." },
				],
				[
					{ name: "Any rev weapon", faq: "Any rev weapon.\nCraw's Bow, Viggora's Chainmace & Thammaron's Sceptre" },
					{ name: "3 Colo Uniques", faq: "Any 3 of the following drops from colosseum:\nSunfire Helm, Body Legs. Echo Crystal & Ralos." },
					{ name: "Any Oathplate", faq: "Any of Oathplate Helm, Body or Legs. Contracts of Oathplate acquisition are not allowed to be used." },
				],
			],
			// Section C (2 paths)
			[
				[
					{ name: "Tourmaline Core", faq: "A Tourmaline core drop." },
					{ name: "Any Nex drop", faq: "Any Nex Unique of:\nTorva Helm, Body, Legs, Vambraces, Ancient hilt or Nihil Horn." },
					{ name: "Doom Drop", faq: "Any doom drop of:\nMokhiatl Cloth, Avernic Treads, Eye of Ayak." },
				],
				[
					{ name: "2 x Nally piece or Neck", faq: "Any 2 Noxious Halberd pieces or 1 Araxyte Fang" },
					{ name: "Claw or 2 x Leather or 1 Leather + 1 Bring", faq: "Any combination of:\n1 Hydra Claw\n2 Hydra Leather\n1 Hydra leather & 1 Full Brimstone Ring" },
					{ name: "PNM Drop", faq: "Any Nightmare drops excluding:\nSlepey Tablet, Parasitic Egg & Pet." },
				],
			],
		],
		boss: { name: "Desert Treasure 2", faq: "Any 2 drops of either:\nFull Ring (gold ring 1, gold ring 2 & Vestige)\nAny SRA piece\nAny Virtus\n\nMeaning:\n1 Full Ring + 1 SRA piece will clear this tile\nor\n1 SRA piece + 1 Virtus\nor 2 Virtus pieces." }
	}
];

function sectionIndex(section: DuoSection): number {
	return DUO_SECTIONS.indexOf(section);
}

// Resolve the positional sheet content onto the canonical board node ids. Throws
// at module load if any node is missing content so a typo fails fast instead of
// silently rendering a blank "?" tile.
const DUO_TILES: Map<string, DuoTileContent> = (() => {
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

export const DUO_TILE_IDS: ReadonlySet<string> = new Set(DUO_TILES.keys());

export function getDuoTileName(id: string): string | null {
	return DUO_TILES.get(id)?.name ?? null;
}

export function getDuoTileFaq(id: string): string | null {
	return DUO_TILES.get(id)?.faq ?? null;
}
