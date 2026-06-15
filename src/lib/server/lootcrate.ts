import { db } from './db';

// SERVER-ONLY gamba-crate (lootcrate) config + roll logic, ported from the Discord
// bot so the site's odds are IDENTICAL. The config is read from the SHARED Supabase
// `bot_config` table (config_name='loot_tables'), exactly like the bot's
// hybridConfig.getLootTables(), with a bundled fallback copied verbatim from there.
// The roll mirrors voli-disc-bot/handlers/lootcrate.js `rollLoot`.

export interface VpTier {
	label: string;
	chance: number; // percent weight
	min: number;
	max: number;
	color?: string; // hex without '#'
	title?: string;
	image?: string;
}

export interface CrateItem {
	name: string;
	chance: number; // relative weight within the item table
	enabled: boolean;
	color?: string;
	image?: string;
}

export interface RoleReward {
	enabled: boolean;
	chance: number;
	roleId: string;
	label?: string;
	color?: string;
	title?: string;
	image?: string;
}

export interface LootConfig {
	spinCost: number;
	freeDropItems: boolean;
	vpTiers: VpTier[];
	itemDropChance: number;
	roleReward?: RoleReward;
	items: CrateItem[];
}

// The single rolled reward. `chance` is the percent (numeric). `colorHex` is a CSS
// color for the reveal. itemName/roleId are set only for their kind.
export interface LootResult {
	kind: 'vp' | 'item' | 'role';
	amount: number;
	itemName: string | null;
	roleId: string | null;
	label: string;
	title: string;
	image: string;
	colorHex: string;
	chance: number;
}

// Bundled fallback — copied verbatim from voli-disc-bot/utils/hybridConfig.js
// getLootTables(). Used only if bot_config has no 'loot_tables' row.
export const DEFAULT_LOOT_TABLES: LootConfig = {
	spinCost: 5,
	freeDropItems: true,
	vpTiers: [
		{ label: 'Junk', chance: 29.7, min: 0, max: 0, color: '808080', title: 'Loot Crate Result', image: 'https://i.imgur.com/jABzYyd.png?v=2' },
		{ label: 'Common (1–3 VP)', chance: 50.0, min: 1, max: 3, color: '808080', title: 'Loot Crate Result', image: 'https://i.imgur.com/EF6qFMM.png' },
		{ label: 'Uncommon (4–10 VP)', chance: 10.0, min: 4, max: 10, color: '808080', title: 'Loot Crate Result', image: 'https://i.imgur.com/FyOzqw2.png' },
		{ label: 'Rare (11–25 VP)', chance: 5.55, min: 11, max: 25, color: '00FF00', title: 'Loot Crate Result', image: 'https://i.imgur.com/SWDduXl.png' },
		{ label: 'Unique (25–50 VP)', chance: 2.2, min: 26, max: 50, color: '00FF00', title: 'Not bad!', image: 'https://i.imgur.com/FIaGFsf.png' },
		{ label: 'Legendary (100 VP)', chance: 0.4, min: 100, max: 100, color: '00FF00', title: "Hooo boy, it's a big one!", image: 'https://i.imgur.com/nYUY964.png' },
		{ label: 'Megarare (200–400 VP)', chance: 0.05, min: 200, max: 400, color: '800080', title: 'VP JACKPOT!', image: 'https://i.imgur.com/uweE4rx.png' }
	],
	itemDropChance: 2.0,
	roleReward: {
		enabled: true,
		chance: 0.01,
		roleId: '1423714480369434675',
		label: 'King Gamba role',
		color: '800080',
		title: 'A King of Gamba has been crowned!',
		image: 'https://i.imgur.com/zeSTA3O.png'
	},
	items: [
		{ name: 'Abyssal Whip', chance: 80, enabled: true, color: '00FF00', image: 'https://i.imgur.com/tMM7G91.png' },
		{ name: "Elidinis' Ward", chance: 16.55, enabled: true, color: '00FF00', image: 'https://i.imgur.com/ZrL4y9r.png' },
		{ name: 'Bond', chance: 2.82, enabled: true, color: '00FF00', image: 'https://i.imgur.com/K9rLNtO.png' },
		{ name: '25M GP', chance: 0.4, enabled: true, color: '800080', image: 'https://i.imgur.com/bEkl6mC.png' },
		{ name: 'Dragon Claws', chance: 0.1, enabled: true, color: '800080', image: 'https://i.imgur.com/Szu9nxV.png' },
		{ name: '100M GP', chance: 0.13, enabled: true, color: '800080', image: 'https://i.imgur.com/CPxoJ4k.png' },
		{ name: 'Twisted Bow', chance: 0.0, enabled: false, color: '800080', image: 'https://i.imgur.com/RzONkPT.png' }
	]
};

let cache: { value: LootConfig; at: number } | null = null;
const CACHE_TTL_MS = 60_000;

// Reads the shared loot-table config from bot_config (same source the bot uses),
// cached for a minute. Falls back to the bundled defaults if unavailable.
export async function getLootConfig(): Promise<LootConfig> {
	if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.value;
	try {
		const { data } = await db()
			.from('bot_config')
			.select('config_value')
			.eq('config_name', 'loot_tables')
			.maybeSingle();
		const value = (data?.config_value as LootConfig) ?? DEFAULT_LOOT_TABLES;
		cache = { value, at: Date.now() };
		return value;
	} catch {
		return DEFAULT_LOOT_TABLES;
	}
}

interface Entry {
	p: number;
	kind: 'vp' | 'role' | 'item';
	label: string;
	min?: number;
	max?: number;
	roleId?: string;
	colorHex: string;
	title: string;
	image?: string;
}

// Weighted single-reward roll — mirrors the bot's rollLoot exactly. allowItems /
// allowRole gate those entries (free claims pass allowRole=false, and allowItems
// per config.freeDropItems).
export function rollLoot(config: LootConfig, allowItems = true, allowRole = true): LootResult {
	const entries: Entry[] = [];

	for (const tier of config.vpTiers) {
		entries.push({
			p: tier.chance,
			kind: 'vp',
			label: tier.label,
			min: tier.min,
			max: tier.max,
			colorHex: `#${tier.color ?? '808080'}`,
			title: tier.title ?? 'Loot Crate Result',
			image: tier.image
		});
	}

	if (config.roleReward?.enabled) {
		entries.push({
			p: config.roleReward.chance,
			kind: 'role',
			label: config.roleReward.label ?? 'Role reward',
			roleId: config.roleReward.roleId,
			colorHex: `#${config.roleReward.color ?? '800080'}`,
			title: config.roleReward.title ?? 'A rare role!',
			image: config.roleReward.image
		});
	}

	entries.push({ p: config.itemDropChance, kind: 'item', label: 'Item Drop', colorHex: '#2b2d31', title: 'Rare Item Drop!' });

	const pool = entries.filter((e) => (allowItems || e.kind !== 'item') && (allowRole || e.kind !== 'role'));
	const totalP = pool.reduce((s, e) => s + e.p, 0);

	let r = Math.random() * totalP;
	let chosen = pool[0];
	for (const e of pool) {
		r -= e.p;
		if (r <= 0) {
			chosen = e;
			break;
		}
	}

	if (chosen.kind === 'vp') {
		const min = chosen.min ?? 0;
		const max = chosen.max ?? 0;
		const amount = min === max ? min : Math.floor(Math.random() * (max - min + 1)) + min;
		return {
			kind: 'vp',
			amount,
			itemName: null,
			roleId: null,
			label: chosen.label,
			title: chosen.title,
			image: chosen.image ?? '',
			colorHex: chosen.colorHex,
			chance: chosen.p
		};
	}

	if (chosen.kind === 'role') {
		return {
			kind: 'role',
			amount: 0,
			itemName: null,
			roleId: chosen.roleId ?? null,
			label: chosen.label,
			title: chosen.title,
			image: chosen.image ?? '',
			colorHex: chosen.colorHex,
			chance: chosen.p
		};
	}

	// Item drop — sub-roll over enabled items only.
	const enabledItems = config.items.filter((i) => i.enabled);
	const itemTotalP = enabledItems.reduce((s, i) => s + i.chance, 0);
	let rr = Math.random() * itemTotalP;
	let it = enabledItems[0];
	for (const i of enabledItems) {
		rr -= i.chance;
		if (rr <= 0) {
			it = i;
			break;
		}
	}
	const effective = itemTotalP > 0 ? (config.itemDropChance * it.chance) / itemTotalP : 0;
	return {
		kind: 'item',
		amount: 0,
		itemName: it.name,
		roleId: null,
		label: 'Item Drop',
		title: chosen.title,
		image: it.image ?? '',
		colorHex: `#${it.color ?? '00FF00'}`,
		chance: effective
	};
}
