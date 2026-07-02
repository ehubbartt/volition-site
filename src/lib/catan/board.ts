// Gielinor Catan board generation — deterministic from a seed so a test board can be
// regenerated/inspected. The generated Board is persisted in vs_events.structure (jsonb).
//
// Ruleset (docs/GIELINOR-CATAN.md): 37-hex map (radius 3), four tile types with raids
// deliberately rare and spread apart, inverted-pyramid rating distribution (low ratings
// scarce), ~7 ports on coastal edges (one 2:1 per token type + three generic 3:1).

import {
	boardHexes,
	coastEdges,
	edgeEndpoints,
	hexDistance,
	hexId,
	type EdgeId,
	type HexId,
	type VertexId
} from './geometry';

export type TileType = 'boss' | 'skilling' | 'raids' | 'custom';
export type PortKind = TileType | 'generic';
export type Rating = 1 | 2 | 3 | 4 | 5;

export interface TileTask {
	label: string;
	unit: string;
	amount: number;
}

export interface BoardTile {
	hex: HexId;
	type: TileType;
	rating: Rating;
	tasks: TileTask[];
}

export interface Port {
	edge: EdgeId;
	vertices: [VertexId, VertexId];
	kind: PortKind;
	rate: 2 | 3;
}

export interface Board {
	radius: number;
	seed: number;
	tiles: Record<HexId, BoardTile>;
	ports: Port[];
}

export const BOARD_RADIUS = 3;

/** Rating counts over 37 tiles — the §2 inverted pyramid (~6/12/20/27/35%). */
const RATING_COUNTS: Record<Rating, number> = { 1: 2, 2: 5, 3: 7, 4: 10, 5: 13 };

/** Type counts — raids scarce (§11: scarcity lives in the map). */
const TYPE_COUNTS: Record<TileType, number> = { raids: 4, boss: 12, skilling: 12, custom: 9 };

/** Raids tiles must sit at least this far apart so 3-raids networks stay a rare feat. */
const RAIDS_MIN_DISTANCE = 3;

// Placeholder task pools for the MVP tester — real task lists come later. `perRating`
// scales linearly with the tile rating (§2: rating 5 ≈ 5× the grind of rating 1).
const TASK_POOLS: Record<TileType, { label: string; unit: string; perRating: number }[]> = {
	boss: [
		{ label: 'Zulrah', unit: 'KC', perRating: 35 },
		{ label: 'Vorkath', unit: 'KC', perRating: 32 },
		{ label: 'Phantom Muspah', unit: 'KC', perRating: 25 },
		{ label: 'Duke Sucellus', unit: 'KC', perRating: 22 },
		{ label: 'General Graardor', unit: 'KC', perRating: 28 },
		{ label: "Kree'arra", unit: 'KC', perRating: 25 },
		{ label: 'Cerberus', unit: 'KC', perRating: 40 },
		{ label: 'Alchemical Hydra', unit: 'KC', perRating: 27 }
	],
	skilling: [
		{ label: 'Agility', unit: 'EHP', perRating: 1 },
		{ label: 'Mining', unit: 'EHP', perRating: 1 },
		{ label: 'Runecraft', unit: 'EHP', perRating: 1 },
		{ label: 'Thieving', unit: 'EHP', perRating: 1 },
		{ label: 'Fishing', unit: 'EHP', perRating: 1 },
		{ label: 'Woodcutting', unit: 'EHP', perRating: 1 },
		{ label: 'Slayer', unit: 'EHP', perRating: 1 },
		{ label: 'Hunter', unit: 'EHP', perRating: 1 }
	],
	raids: [
		{ label: 'Chambers of Xeric', unit: 'KC', perRating: 3 },
		{ label: 'Theatre of Blood', unit: 'KC', perRating: 3 },
		{ label: 'Tombs of Amascut (Expert)', unit: 'KC', perRating: 4 }
	],
	custom: [
		{ label: 'Hard clue caskets', unit: 'opened', perRating: 8 },
		{ label: 'Wintertodt rounds', unit: 'rounds', perRating: 10 },
		{ label: 'Barbarian Assault waves', unit: 'waves', perRating: 12 },
		{ label: 'Pest Control games', unit: 'games', perRating: 15 },
		{ label: 'Guardians of the Rift games', unit: 'games', perRating: 10 },
		{ label: 'Tempoross', unit: 'KC', perRating: 12 }
	]
};

const TASKS_PER_TILE = 3;
const PORT_LAYOUT: PortKind[] = ['boss', 'skilling', 'raids', 'custom', 'generic', 'generic', 'generic'];

/** mulberry32 — tiny deterministic PRNG. */
function rng(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a |= 0;
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

function shuffle<T>(arr: T[], rand: () => number): T[] {
	const a = [...arr];
	for (let i = a.length - 1; i > 0; i--) {
		const j = Math.floor(rand() * (i + 1));
		[a[i], a[j]] = [a[j], a[i]];
	}
	return a;
}

export function generateBoard(seed: number): Board {
	const rand = rng(seed);
	const hexes = boardHexes(BOARD_RADIUS);

	// 1) Place the raids tiles: rejection-sample until all pairs are ≥ RAIDS_MIN_DISTANCE apart.
	let raidsHexes: typeof hexes = [];
	for (let attempt = 0; attempt < 1000; attempt++) {
		const picks = shuffle(hexes, rand).slice(0, TYPE_COUNTS.raids);
		const ok = picks.every((a, i) => picks.every((b, j) => i >= j || hexDistance(a, b) >= RAIDS_MIN_DISTANCE));
		if (ok) {
			raidsHexes = picks;
			break;
		}
	}
	if (raidsHexes.length === 0) throw new Error('could not place raids tiles');
	const raidsIds = new Set(raidsHexes.map((h) => hexId(h.q, h.r)));

	// 2) Deal the remaining types and all ratings by shuffle.
	const restTypes: TileType[] = shuffle(
		[
			...Array<TileType>(TYPE_COUNTS.boss).fill('boss'),
			...Array<TileType>(TYPE_COUNTS.skilling).fill('skilling'),
			...Array<TileType>(TYPE_COUNTS.custom).fill('custom')
		],
		rand
	);
	const ratings = shuffle(
		(Object.entries(RATING_COUNTS) as unknown as [string, number][]).flatMap(([r, n]) =>
			Array<Rating>(n).fill(Number(r) as Rating)
		),
		rand
	);

	const tiles: Record<HexId, BoardTile> = {};
	let ri = 0;
	for (const h of hexes) {
		const id = hexId(h.q, h.r);
		const type = raidsIds.has(id) ? 'raids' : restTypes[ri++];
		const rating = ratings[Object.keys(tiles).length] as Rating;
		const pool = shuffle(TASK_POOLS[type], rand).slice(0, TASKS_PER_TILE);
		tiles[id] = {
			hex: id,
			type,
			rating,
			tasks: pool.map((t) => ({
				label: t.label,
				unit: t.unit,
				amount: Math.max(1, Math.round(t.perRating * rating))
			}))
		};
	}

	// 3) Ports: spread PORT_LAYOUT evenly around the coast (42 coastal edges / 7 ports).
	const coast = coastEdges(hexes);
	const kinds = shuffle(PORT_LAYOUT, rand);
	const offset = Math.floor(rand() * coast.length);
	const step = coast.length / kinds.length;
	const ports: Port[] = kinds.map((kind, i) => {
		const edge = coast[(offset + Math.round(i * step)) % coast.length];
		return { edge, vertices: edgeEndpoints(edge), kind, rate: kind === 'generic' ? 3 : 2 };
	});

	return { radius: BOARD_RADIUS, seed, tiles, ports };
}

export const TILE_TYPE_LABEL: Record<TileType, string> = {
	boss: 'Boss',
	skilling: 'Skilling',
	raids: 'Raids',
	custom: 'Custom'
};

export const TOKEN_LABEL: Record<TileType | 'gold', string> = {
	boss: 'Boss (B)',
	skilling: 'Skilling (S)',
	raids: 'Raids (R)',
	custom: 'Custom (C)',
	gold: 'Gold'
};
