import { redirect, error, fail } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { isAdmin, type SessionUser } from '$lib/server/auth';
import {
	getPlayerVp,
	spendPlayerVp,
	grantPlayerVp,
	claimFreeLootDay,
	getLastLootDate,
	getPlayerGold,
	spendGold,
	grantGold,
	convertWalletToGold,
	getWalletItems
} from '$lib/server/playerStats';
import { itemPrice, formatGP } from '$lib/gp';
import { grantCards, grantUserPack, logPackOpen, makeSlotRoller, rollOnePack, type CardGrant } from '$lib/server/gamba';
import { isClanMember } from '$lib/server/clan';
import {
	getWeeklyFreePack,
	getWeeklyClaimAt,
	claimedThisWeek,
	claimWeeklyPack as runWeeklyClaim
} from '$lib/server/weeklyPack';
import { nextWeeklyResetIso } from '$lib/tasks';
import { getLootConfig, isPaidCrateEnabled, rollLoot, type LootConfig, type LootResult } from '$lib/server/lootcrate';
import { logLootcrateOpen, shouldBroadcastCrateDrop } from '$lib/server/lootcrateAnalytics';
import { sendBotMessage } from '$lib/server/botBridge';
import { postCardDrop, postCrateDrop } from '$lib/server/dropsFeed';
import { isValidRarity, DEFAULT_RARITY, RARE_RARITIES, RARITIES, toCardLayers, hiddenCard, type Card, type CardAbility, type CardLayer, type CardRarity } from '$lib/cards/rarity';
import { isValidFinish, type CardFinish } from '$lib/cards/finishes';
import type { Actions, PageServerLoad } from './$types';

interface CardRow {
	id: string;
	name: string;
	level: number | null;
	rarity: string;
	abilities: CardAbility[] | null;
	flavor: string | null;
	front_url: string | null;
	back_url: string | null;
	layers: unknown;
	full_art: boolean | null;
	holo_url: string | null;
	holo_border: boolean | null;
	sound_url: string | null;
	model_url: string | null;
	model_settings: Card['model_settings'];
	models: Card['models'];
}

// A card row for the "view cards" pack-contents grid (no drop rates).
interface PackCardRow {
	id: string;
	name: string;
	level: number | null;
	rarity: string;
	abilities: CardAbility[] | null;
	flavor: string | null;
	front_url: string | null;
	back_url: string | null;
	layers: unknown;
	full_art: boolean | null;
	holo_url: string | null;
	holo_border: boolean | null;
	model_url: string | null;
	model_settings: Card['model_settings'];
	models: Card['models'];
	pack_id: string | null;
}

function toPackCard(r: PackCardRow): Card {
	return {
		id: r.id,
		name: r.name,
		level: r.level,
		rarity: (isValidRarity(r.rarity) ? r.rarity : DEFAULT_RARITY) as CardRarity,
		abilities: r.abilities ?? [],
		flavor: r.flavor,
		front_url: r.front_url,
		back_url: r.back_url,
		layers: toCardLayers(r.layers),
		full_art: !!r.full_art,
		holo_url: r.holo_url,
		holo_border: !!r.holo_border,
		sound_url: null,
		model_url: r.model_url,
		model_settings: r.model_settings ?? null,
		models: r.models ?? [],
		holo_regular_url: null,
		holo_reverse_url: null
	};
}

interface RarePullRow {
	id: string;
	card_name: string;
	rarity: string;
	finish: string;
	pulled_at: string;
	vs_users: { rsn: string | null; discord_username: string | null } | null;
	vs_cards: { front_url: string | null; full_art: boolean | null; layers: unknown } | null;
	vs_pack_opens: { pack_name: string | null } | null;
}

export interface RarePull {
	id: string;
	cardName: string;
	rarity: CardRarity;
	finish: CardFinish;
	frontUrl: string | null;
	fullArt: boolean;
	layers: CardLayer[]; // depth layers composited over the front (2D)
	by: string; // display name
	rsn: string | null; // for the /u/[rsn] link (null = no link)
	packName: string | null; // which pack it was opened from
	pulledAt: string;
}

// One odds row for the crate's drop-rate display.
export interface CrateOdd {
	label: string;
	pct: number;
	color: string;
}

// One cell on the spinning reel (every possible reward bucket — VP tiers, items,
// role). The opener scrolls through these and lands on the won one.
export interface CrateReelCell {
	label: string;
	image: string | null;
	colorHex: string;
}

export interface CrateInfo {
	spinCost: number;
	paidEnabled: boolean;
	freeAvailable: boolean;
	odds: CrateOdd[];
	reel: CrateReelCell[];
}

// Client-safe rolled reward (no roleId) for the reveal modal.
export interface CrateReward {
	kind: 'vp' | 'item' | 'role';
	amount: number;
	itemName: string | null;
	label: string;
	title: string;
	image: string;
	colorHex: string;
	chance: number;
	isFree: boolean;
}

function toCrateReward(result: LootResult, isFree: boolean): CrateReward {
	return {
		kind: result.kind,
		amount: result.amount,
		itemName: result.itemName,
		label: result.label,
		title: result.title,
		image: result.image,
		colorHex: result.colorHex,
		chance: result.chance,
		isFree
	};
}

// Grants a rolled crate reward: VP → players.points, item → wallet_items, role →
// site→bot webhook bridge (the site can't assign Discord roles). Then mirrors the
// bot's analytics. All best-effort — the spend/free-claim already happened.
async function applyCrateReward(user: SessionUser, isFree: boolean, result: LootResult): Promise<void> {
	if (result.kind === 'vp' && result.amount > 0) {
		await grantPlayerVp(user.discord_id, user.rsn, result.amount);
	} else if (result.kind === 'item' && result.itemName) {
		const { error: wErr } = await db()
			.from('wallet_items')
			.insert({ user_id: user.discord_id, item_name: result.itemName, username: user.discord_username });
		if (wErr) console.error('[crate] wallet insert failed:', wErr.message);
	} else if (result.kind === 'role' && result.roleId) {
		await sendBotMessage('grant_role', {
			discord_id: user.discord_id,
			role_id: result.roleId,
			username: user.discord_username,
			reason: 'gamba crate'
		});
	}
	await logLootcrateOpen(user.discord_id, isFree, result, user.discord_username);

	// Forward notable crate rewards to the public Discord drops channel: items + the
	// role always, but a VP reward only when it's big (> 25 VP) — a higher bar than the
	// rare-drops LOG (isRareDrop), so the channel isn't spammed with small VP wins.
	if (shouldBroadcastCrateDrop(result)) {
		const reward =
			result.kind === 'vp'
				? `${result.amount.toLocaleString()} VP`
				: result.kind === 'item'
					? result.itemName ?? 'Item'
					: (result.label || 'Role').replace(/ role$/i, '');
		// `result.label` already carries the tier/table name (e.g. "Common (1–3 VP)").
		// Read the post-grant balance for "New Total VP" (best-effort, like the bot).
		const newTotalVp = await getPlayerVp(user.discord_id, user.rsn);
		await postCrateDrop({
			by: user.rsn || user.discord_username || 'Someone',
			rsn: user.rsn,
			reward,
			isFree,
			colorHex: result.colorHex,
			imageUrl: result.image,
			lootTable: result.label || null,
			dropRate: result.chance,
			newTotalVp
		});
	}
}

// --- Crate "Live drops" feed (from the bot's lootcrate_rare_drops log) ---------

interface CrateDropRow {
	id: number;
	user_id: string;
	username: string | null;
	drop_type: string; // 'vp' | 'item' | 'role'
	item_name: string | null;
	amount: number | null;
	was_free: boolean | null;
	timestamp: string;
}

export interface CrateDrop {
	id: number;
	kind: 'vp' | 'item' | 'role';
	label: string; // "200 VP" / item name / "King Gamba"
	image: string | null;
	colorHex: string;
	by: string;
	rsn: string | null;
	isFree: boolean;
	at: string; // ISO (UTC)
}

// lootcrate_rare_drops.timestamp is a tz-less column stored in UTC — normalise so
// the client parses it as UTC, not local time.
function toIsoUtc(ts: string | null): string {
	if (!ts) return new Date(0).toISOString();
	if (/[zZ]|[+-]\d\d:?\d\d$/.test(ts)) return ts;
	return ts.replace(' ', 'T') + 'Z';
}

// Resolves a raw rare-drop row into a display entry, pulling art/colour from the
// loot config (by item name / VP tier / role) and a display name from vs_users.
function resolveCrateDrop(
	row: CrateDropRow,
	config: LootConfig,
	nameMap: Map<string, { rsn: string | null; discord_username: string | null }>
): CrateDrop {
	let label = '';
	let image: string | null = null;
	let colorHex = '#9a8c78';

	if (row.drop_type === 'item') {
		const it = config.items.find((i) => i.name === row.item_name);
		label = row.item_name ?? 'Item';
		image = it?.image ?? null;
		colorHex = it?.color ? `#${it.color}` : '#00ff7b';
	} else if (row.drop_type === 'role') {
		label = (config.roleReward?.label ?? 'King Gamba').replace(/ role$/i, '');
		image = config.roleReward?.image ?? null;
		colorHex = config.roleReward?.color ? `#${config.roleReward.color}` : '#b06bff';
	} else {
		const amt = row.amount ?? 0;
		const tier = config.vpTiers.find((t) => amt >= t.min && amt <= t.max);
		label = `${amt.toLocaleString()} VP`;
		image = tier?.image ?? null;
		colorHex = tier?.color ? `#${tier.color}` : '#ffc63a';
	}

	const u = nameMap.get(row.user_id);
	return {
		id: row.id,
		kind: (row.drop_type === 'item' || row.drop_type === 'role' ? row.drop_type : 'vp') as CrateDrop['kind'],
		label,
		image,
		colorHex,
		by: u?.rsn || u?.discord_username || row.username || 'Someone',
		rsn: u?.rsn ?? null,
		isFree: !!row.was_free,
		at: toIsoUtc(row.timestamp)
	};
}

// Player-facing pack store — open to any onboarded member. (Admin card tooling
// under /admin/* stays card-tester gated.)
export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) throw redirect(303, '/');
	if (!locals.user.rsn || !locals.user.clan_allegiance || !locals.user.account_type) {
		throw redirect(303, '/onboarding');
	}

	const [vp_balance, gold_balance, wallet, packsRes, cardsRes, ownedRes, raresRes, lastLootDate, lootConfig, crateDropsRes, ownedPacksRes] = await Promise.all([
		getPlayerVp(locals.user.discord_id, locals.user.rsn),
		getPlayerGold(locals.user.discord_id, locals.user.rsn),
		getWalletItems(locals.user.discord_id),
		db()
			.from('vs_card_packs')
			.select('id, name, description, cost_vp, cost_gp, cards_per_pack, front_url, back_url')
			.eq('released', true)
			.order('cost_vp', { ascending: true }),
		db()
			.from('vs_cards')
			.select('id, name, level, rarity, abilities, flavor, front_url, back_url, layers, full_art, holo_url, holo_border, model_url, model_settings, models, pack_id'),
		// Which cards this player owns — so a secret rare they've pulled is revealed
		// in the set preview instead of staying a mystery spot.
		db().from('vs_user_cards').select('card_id').eq('user_id', locals.user.id),
		// Recently opened rares (dragon+), newest first — the live drop ticker. Reads
		// the pack-open line items directly (the rarity filter is a plain indexed query).
		db()
			.from('vs_pack_open_cards')
			.select(
				'id, card_name, rarity, finish, pulled_at, vs_users(rsn, discord_username), vs_cards(front_url, full_art, layers), vs_pack_opens(pack_name)'
			)
			.in('rarity', RARE_RARITIES)
			.order('pulled_at', { ascending: false })
			.limit(20),
		getLastLootDate(locals.user.discord_id, locals.user.rsn),
		getLootConfig(),
		// Recent notable crate drops (the bot's rare-drop log; the site writes here too).
		// Over-fetch so the small-VP filter below still leaves a full feed.
		db()
			.from('lootcrate_rare_drops')
			.select('id, user_id, username, drop_type, item_name, amount, was_free, timestamp')
			.order('timestamp', { ascending: false })
			.limit(50),
		// Packs this player already owns (unopened) — so the store can offer a free
		// "open from inventory" instead of buying. Join the pack details so owned
		// packs that aren't in the released store list can still be shown + opened.
		db()
			.from('vs_user_packs')
			.select('quantity, vs_card_packs(id, name, description, cost_vp, cost_gp, cards_per_pack, front_url, back_url)')
			.eq('user_id', locals.user.id)
			.gt('quantity', 0)
	]);

	// Total GP value sitting unpaid in the player's wallet (for the "convert" panel).
	const walletGpValue = wallet.reduce((sum, i) => sum + itemPrice(i.name) * i.quantity, 0);

	if (packsRes.error) throw error(500, packsRes.error.message);

	// Gamba crate (shared lootcrate) — odds + free-claim availability.
	const todayUtc = new Date().toISOString().slice(0, 10);
	const crate: CrateInfo = {
		spinCost: lootConfig.spinCost ?? 5,
		paidEnabled: isPaidCrateEnabled(lootConfig),
		freeAvailable: lastLootDate !== todayUtc,
		odds: [
			...lootConfig.vpTiers.map((t) => ({ label: t.label, pct: t.chance, color: `#${t.color ?? '808080'}` })),
			{ label: 'Rare item', pct: lootConfig.itemDropChance, color: '#00ff7b' },
			...(lootConfig.roleReward?.enabled
				? [{ label: lootConfig.roleReward.label ?? 'Role', pct: lootConfig.roleReward.chance, color: `#${lootConfig.roleReward.color ?? '800080'}` }]
				: [])
		],
		// Every possible reward as a reel cell (VP tiers + enabled items + role).
		reel: [
			...lootConfig.vpTiers.map((t) => ({
				label: t.label,
				image: t.image ?? null,
				colorHex: `#${t.color ?? '808080'}`
			})),
			...lootConfig.items
				.filter((i) => i.enabled)
				.map((i) => ({ label: i.name, image: i.image ?? null, colorHex: `#${i.color ?? '00FF00'}` })),
			...(lootConfig.roleReward?.enabled
				? [
						{
							label: lootConfig.roleReward.label ?? 'Role',
							image: lootConfig.roleReward.image ?? null,
							colorHex: `#${lootConfig.roleReward.color ?? '800080'}`
						}
					]
				: [])
		]
	};

	// Resolve the recent crate drops into a display feed: names/links come from
	// vs_users (lootcrate rows key by discord_id with no FK, so we look them up).
	// Filter out small VP wins (< 25 VP) — items and the role always stay.
	const crateDropRows = ((crateDropsRes.data ?? []) as CrateDropRow[])
		.filter((r) => r.drop_type !== 'vp' || (r.amount ?? 0) >= 25)
		.slice(0, 20);
	const dropUserIds = [...new Set(crateDropRows.map((r) => r.user_id).filter(Boolean))];
	const nameMap = new Map<string, { rsn: string | null; discord_username: string | null }>();
	if (dropUserIds.length) {
		const { data: us } = await db()
			.from('vs_users')
			.select('discord_id, rsn, discord_username')
			.in('discord_id', dropUserIds);
		for (const u of us ?? []) nameMap.set(u.discord_id, { rsn: u.rsn, discord_username: u.discord_username });
	}
	const recentCrateDrops: CrateDrop[] = crateDropRows.map((r) => resolveCrateDrop(r, lootConfig, nameMap));

	// Group each set's cards (for the count + the "view cards" contents grid).
	// SR ("secret rare") cards stay a surprise: an unowned SR shows as a REDACTED
	// mystery spot (its real data never reaches the client), while one the player
	// has already pulled is revealed normally.
	const ownedCardIds = new Set(
		((ownedRes.data ?? []) as { card_id: string }[]).map((r) => r.card_id)
	);
	const byPack = new Map<string, Card[]>();
	for (const r of (cardsRes.data ?? []) as PackCardRow[]) {
		if (!r.pack_id) continue;
		const card =
			r.rarity === 'sr' && !ownedCardIds.has(r.id) ? hiddenCard(r.id, 'sr') : toPackCard(r);
		const arr = byPack.get(r.pack_id) ?? [];
		arr.push(card);
		byPack.set(r.pack_id, arr);
	}
	const rarityRank = new Map(RARITIES.map((r, i) => [r.key as string, i]));
	const sortSetCards = (packId: string) =>
		(byPack.get(packId) ?? []).sort(
			(a, b) => (rarityRank.get(b.rarity) ?? 0) - (rarityRank.get(a.rarity) ?? 0) || a.name.localeCompare(b.name)
		);

	// How many of each pack this player owns (unopened), for the free inventory open.
	const ownedPackRows = (ownedPacksRes.data ?? []) as unknown as {
		quantity: number;
		vs_card_packs: {
			id: string;
			name: string;
			description: string | null;
			cost_vp: number;
			cost_gp: number | null;
			cards_per_pack: number;
			front_url: string | null;
			back_url: string | null;
		} | null;
	}[];
	const ownedQty = new Map<string, number>();
	for (const r of ownedPackRows) if (r.vs_card_packs) ownedQty.set(r.vs_card_packs.id, r.quantity);

	const releasedPacks = (packsRes.data ?? []).map((p) => {
		const cards = sortSetCards(p.id);
		return { ...p, card_count: cards.length, cards, owned: ownedQty.get(p.id) ?? 0 };
	});

	// Owned packs not in the released store list (e.g. a granted / unreleased pack) —
	// surface them too so the player can open what they hold.
	const releasedIds = new Set(releasedPacks.map((p) => p.id));
	const extraOwnedPacks = ownedPackRows
		.filter((r) => r.vs_card_packs && !releasedIds.has(r.vs_card_packs.id))
		.map((r) => {
			const p = r.vs_card_packs!;
			const cards = sortSetCards(p.id);
			return {
				id: p.id,
				name: p.name,
				description: p.description,
				cost_vp: p.cost_vp,
				cost_gp: p.cost_gp ?? null,
				cards_per_pack: p.cards_per_pack,
				front_url: p.front_url,
				back_url: p.back_url,
				card_count: cards.length,
				cards,
				owned: r.quantity
			};
		});

	const packs = [...releasedPacks, ...extraOwnedPacks];

	// Teaser packs: UNRELEASED packs flagged `teaser` → shown in the store as locked
	// "coming soon" cards. Only their name + art reach the client (no cost / card
	// count / cards / description) and they can't be opened. Released packs drop out
	// automatically (they appear as normal openable packs above).
	const { data: teaserRows } = await db()
		.from('vs_card_packs')
		.select('id, name, front_url, back_url')
		.eq('teaser', true)
		.eq('released', false)
		.order('name', { ascending: true });
	const teaserPacks = (teaserRows ?? []) as {
		id: string;
		name: string;
		front_url: string | null;
		back_url: string | null;
	}[];

	const recentRares: RarePull[] = ((raresRes.data ?? []) as unknown as RarePullRow[]).map((r) => ({
		id: r.id,
		cardName: r.card_name,
		rarity: (isValidRarity(r.rarity) ? r.rarity : DEFAULT_RARITY) as CardRarity,
		finish: (isValidFinish(r.finish) ? r.finish : 'normal') as CardFinish,
		frontUrl: r.vs_cards?.front_url ?? null,
		fullArt: !!r.vs_cards?.full_art,
		layers: toCardLayers(r.vs_cards?.layers),
		by: r.vs_users?.rsn || r.vs_users?.discord_username || 'Someone',
		rsn: r.vs_users?.rsn ?? null,
		packName: r.vs_pack_opens?.pack_name ?? null,
		pulledAt: r.pulled_at
	}));

	// Free weekly pack (claimed here, like the daily crate). Show the admin-flagged
	// pack + this user's claim status; clan-membership is re-checked in the action.
	const weeklyFreePack = await getWeeklyFreePack();
	let weeklyPack:
		| {
				name: string;
				front_url: string | null;
				back_url: string | null;
				claimedThisWeek: boolean;
				claimable: boolean;
				isMember: boolean;
				resetAt: string;
		  }
		| null = null;
	if (weeklyFreePack) {
		const [claimAt, member] = await Promise.all([
			getWeeklyClaimAt(locals.user.id),
			isClanMember(locals.user.discord_id, locals.user.rsn)
		]);
		const claimed = claimedThisWeek(claimAt);
		weeklyPack = {
			name: weeklyFreePack.name,
			front_url: weeklyFreePack.front_url,
			back_url: weeklyFreePack.back_url,
			claimedThisWeek: claimed,
			claimable: member && !claimed,
			isMember: member,
			resetAt: nextWeeklyResetIso()
		};
	}

	return {
		vp_balance,
		gold_balance,
		walletGpValue,
		packs,
		teaserPacks,
		recentRares,
		crate,
		recentCrateDrops,
		weeklyPack
	};
};

// A pack's roll-relevant columns (shared by the VP open and the inventory open).
interface OpenablePack {
	id: string;
	name: string;
	cost_vp: number | null;
	cost_gp: number | null;
	cards_per_pack: number | null;
	rarity_weights: unknown;
	slot_weights: unknown;
	slot_finishes: unknown;
	front_url: string | null;
	back_url: string | null;
	holo_regular_url: string | null;
	holo_reverse_url: string | null;
}

// Shared open core: roll the pack, grant the cards, log it, forward rare pulls, and
// build the reveal payload. Used by both the VP buy (`open`) and the inventory open
// (`openOwned`). The CALLER handles the cost side (spend VP / consume a pack) and
// refunds it if this returns an error. `costVp` is recorded on the open (0 = free).
async function rollGrantReveal(
	user: SessionUser,
	pack: OpenablePack,
	costVp: number
): Promise<{ ok: true; opened: (Card & { finish: CardFinish; isNew: boolean })[]; openId: string | null } | { ok: false; error: string }> {
	const { data: poolRows, error: poolErr } = await db()
		.from('vs_cards')
		.select('id, name, level, rarity, abilities, flavor, front_url, back_url, layers, full_art, holo_url, holo_border, sound_url, model_url, model_settings, models')
		.eq('pack_id', pack.id);
	if (poolErr) return { ok: false, error: poolErr.message };
	const pool = (poolRows ?? []) as CardRow[];
	if (pool.length === 0) return { ok: false, error: 'This pack has no cards yet.' };
	for (const c of pool) if (!isValidRarity(c.rarity)) c.rarity = DEFAULT_RARITY;

	const n = Math.max(1, pack.cards_per_pack ?? 5);
	const pick = makeSlotRoller(pool);
	const rolled = rollOnePack<CardRow>(pick, {
		cardsPerPack: n,
		slotWeights: (Array.isArray(pack.slot_weights) ? pack.slot_weights : []) as Record<string, number>[],
		rarityWeights: (pack.rarity_weights as Record<string, number> | null) ?? null,
		slotFinishes: (Array.isArray(pack.slot_finishes) ? pack.slot_finishes : []) as { holo: number; reverse: number }[]
	});

	const grants: CardGrant[] = rolled.map((r) => ({ card_id: r.card.id, finish: r.finish }));
	const grant = await grantCards(user.id, grants);
	if (!grant.ok) return { ok: false, error: 'Could not add the cards to your collection' };
	const newKeys = grant.newKeys;

	// Rare pulls are NOT forwarded to the drops feed here — that happens later, via
	// the announceDrops action, only once the player actually rips the pack open.
	const openId = await logPackOpen({
		userId: user.id,
		packId: pack.id,
		packName: pack.name,
		costVp,
		cards: rolled.map((r) => ({ card_id: r.card.id, card_name: r.card.name, rarity: r.card.rarity, finish: r.finish }))
	});

	const opened: (Card & { finish: CardFinish; isNew: boolean })[] = rolled.map((r) => ({
		id: r.card.id,
		name: r.card.name,
		level: r.card.level,
		rarity: (isValidRarity(r.card.rarity) ? r.card.rarity : DEFAULT_RARITY) as CardRarity,
		abilities: r.card.abilities ?? [],
		flavor: r.card.flavor,
		front_url: r.card.front_url,
		back_url: r.card.back_url,
		layers: toCardLayers(r.card.layers),
		full_art: !!r.card.full_art,
		holo_url: r.card.holo_url,
		holo_border: !!r.card.holo_border,
		sound_url: r.card.sound_url,
		model_url: r.card.model_url,
		model_settings: r.card.model_settings ?? null,
		models: r.card.models ?? [],
		holo_regular_url: pack.holo_regular_url,
		holo_reverse_url: pack.holo_reverse_url,
		finish: r.finish,
		isNew: newKeys.has(`${r.card.id}|${r.finish}`)
	}));
	return { ok: true, opened, openId };
}

// Consume one owned pack — race-safe optimistic decrement (deletes the row at 0).
// Returns false if the player has none (or a concurrent open beat us to it).
async function consumeUserPack(userId: string, packId: string): Promise<boolean> {
	const { data: row } = await db()
		.from('vs_user_packs')
		.select('id, quantity')
		.eq('user_id', userId)
		.eq('pack_id', packId)
		.maybeSingle();
	if (!row || (row.quantity ?? 0) < 1) return false;
	if (row.quantity <= 1) {
		const { error: dErr, count } = await db()
			.from('vs_user_packs')
			.delete({ count: 'exact' })
			.eq('id', row.id)
			.eq('quantity', row.quantity);
		return !dErr && !!count;
	}
	const { error: uErr, count } = await db()
		.from('vs_user_packs')
		.update({ quantity: row.quantity - 1, updated_at: new Date().toISOString() }, { count: 'exact' })
		.eq('id', row.id)
		.eq('quantity', row.quantity);
	return !uErr && !!count;
}

// Give one pack back (refund after a failed owned-open).
async function refundUserPack(userId: string, packId: string): Promise<void> {
	await grantUserPack(userId, packId, 1);
}

export const actions: Actions = {
	// Claim the free weekly pack (clan members; once per week). On success the load
	// re-runs → the card flips to "Claimed" and the pack appears in inventory.
	claimWeeklyPack: async ({ locals }) => {
		if (!locals.user) throw error(401, 'Sign in first');
		const res = await runWeeklyClaim(locals.user);
		if (!res.ok) {
			const msg =
				res.reason === 'already'
					? "You've already claimed this week's pack — back after the weekly reset."
					: res.reason === 'not_member'
						? 'Only Volition clan members can claim the weekly pack.'
						: res.reason === 'none'
							? 'There is no weekly pack available right now.'
							: 'Could not claim the weekly pack — please try again.';
			return fail(400, { weeklyError: msg });
		}
		return { weeklyOk: true, claimed: res.packName };
	},

	open: async ({ locals, request }) => {
		if (!locals.user) throw error(401, 'Sign in first');

		const form = await request.formData();
		const packId = form.get('pack_id')?.toString();
		if (!packId) return fail(400, { error: 'Missing pack' });

		// Pack must exist AND be released.
		const { data: pack, error: pErr } = await db()
			.from('vs_card_packs')
			.select('id, name, cost_vp, cost_gp, cards_per_pack, rarity_weights, slot_weights, slot_finishes, front_url, back_url, released, holo_regular_url, holo_reverse_url')
			.eq('id', packId)
			.maybeSingle();
		if (pErr) return fail(500, { error: pErr.message });
		if (!pack || !pack.released) return fail(404, { error: 'That pack is not available.' });

		const cost = pack.cost_vp ?? 0;

		// Spend VP first (optimistic — only if affordable and unchanged), then roll +
		// grant; refund the VP if the roll/grant fails.
		const spend = await spendPlayerVp(locals.user.discord_id, locals.user.rsn, cost);
		if (!spend.ok) {
			const msg =
				spend.reason === 'insufficient'
					? `Not enough VP — this pack costs ${cost.toLocaleString()} VP and you have ${spend.balance.toLocaleString()}.`
					: spend.reason === 'no_player'
						? 'No RuneScape player record is linked to your account, so you have no VP to spend.'
						: 'Could not complete the purchase — please try again.';
			return fail(400, { error: msg, balance: spend.balance });
		}

		const res = await rollGrantReveal(locals.user, pack, cost);
		if (!res.ok) {
			await grantPlayerVp(locals.user.discord_id, locals.user.rsn, cost);
			return fail(500, { error: `${res.error} — your VP was refunded.` });
		}

		return {
			ok: true,
			opened: res.opened,
			openId: res.openId,
			pack: { name: pack.name, front_url: pack.front_url, back_url: pack.back_url },
			balance: spend.balance
		};
	},

	// Buy a pack with the wallet GP balance (players.gold_balance). Same shape as `open`
	// but spends GP instead of VP; the pack must have a cost_gp set (else it's VP-only).
	openWithGp: async ({ locals, request }) => {
		if (!locals.user) throw error(401, 'Sign in first');
		// GP / wallet buying is admin-only for now (while it's being tested).
		if (!isAdmin(locals.user)) return fail(403, { error: 'Buying with your wallet is not available yet.' });

		const form = await request.formData();
		const packId = form.get('pack_id')?.toString();
		if (!packId) return fail(400, { error: 'Missing pack' });

		const { data: pack, error: pErr } = await db()
			.from('vs_card_packs')
			.select('id, name, cost_vp, cost_gp, cards_per_pack, rarity_weights, slot_weights, slot_finishes, front_url, back_url, released, holo_regular_url, holo_reverse_url')
			.eq('id', packId)
			.maybeSingle();
		if (pErr) return fail(500, { error: pErr.message });
		if (!pack || !pack.released) return fail(404, { error: 'That pack is not available.' });

		const cost = pack.cost_gp ?? 0;
		if (cost <= 0) return fail(400, { error: "This pack can't be bought with GP." });

		// Spend GP first (optimistic), then roll + grant; refund the GP if the roll fails.
		const spend = await spendGold(locals.user.discord_id, locals.user.rsn, cost);
		if (!spend.ok) {
			const msg =
				spend.reason === 'insufficient'
					? `Not enough in your wallet — this pack costs ${formatGP(cost)} and you have ${formatGP(spend.balance)}. Convert your wallet items first.`
					: spend.reason === 'no_player'
						? 'No RuneScape player record is linked to your account, so you have no wallet balance.'
						: 'Could not complete the purchase — please try again.';
			return fail(400, { error: msg, goldBalance: spend.balance });
		}

		const res = await rollGrantReveal(locals.user, pack, 0);
		if (!res.ok) {
			await grantGold(locals.user.discord_id, locals.user.rsn, cost);
			return fail(500, { error: `${res.error} — your GP was refunded.` });
		}

		return {
			ok: true,
			opened: res.opened,
			openId: res.openId,
			pack: { name: pack.name, front_url: pack.front_url, back_url: pack.back_url },
			goldBalance: spend.balance
		};
	},

	// Convert ALL of the player's unpaid wallet items into GP (gold_balance).
	convertWallet: async ({ locals }) => {
		if (!locals.user) throw error(401, 'Sign in first');
		// Wallet → GP conversion is admin-only for now (while it's being tested).
		if (!isAdmin(locals.user)) return fail(403, { convertError: 'Converting your wallet is not available yet.' });
		const res = await convertWalletToGold(locals.user.discord_id, locals.user.rsn);
		if (!res.ok) {
			const msg =
				res.reason === 'empty'
					? 'Your wallet has nothing to convert.'
					: res.reason === 'no_player'
						? 'No RuneScape player record is linked to your account.'
						: 'Could not convert your wallet — please try again.';
			return fail(400, { convertError: msg });
		}
		return { convertOk: true, gained: res.gained, goldBalance: res.newBalance };
	},

	// Open a pack the player already OWNS (consume a vs_user_packs row — no VP cost).
	openOwned: async ({ locals, request }) => {
		if (!locals.user) throw error(401, 'Sign in first');

		const form = await request.formData();
		const packId = form.get('pack_id')?.toString();
		if (!packId) return fail(400, { error: 'Missing pack' });

		const { data: pack, error: pErr } = await db()
			.from('vs_card_packs')
			.select('id, name, cost_vp, cost_gp, cards_per_pack, rarity_weights, slot_weights, slot_finishes, front_url, back_url, holo_regular_url, holo_reverse_url')
			.eq('id', packId)
			.maybeSingle();
		if (pErr) return fail(500, { error: pErr.message });
		if (!pack) return fail(404, { error: 'That pack no longer exists.' });

		// Consume one of the player's owned packs (race-safe). Refund it if the open
		// then fails so they never lose a pack for nothing.
		const consumed = await consumeUserPack(locals.user.id, packId);
		if (!consumed) return fail(400, { error: "You don't have that pack to open." });

		const res = await rollGrantReveal(locals.user, pack, 0);
		if (!res.ok) {
			await refundUserPack(locals.user.id, packId);
			return fail(500, { error: `${res.error} — your pack was refunded.` });
		}

		const balance = await getPlayerVp(locals.user.discord_id, locals.user.rsn);
		return {
			ok: true,
			opened: res.opened,
			openId: res.openId,
			pack: { name: pack.name, front_url: pack.front_url, back_url: pack.back_url },
			balance
		};
	},

	// Forward ONE rare pull (dragon+) to the Discord drops feed — called by the client
	// when the player actually SWIPES TO that card in the opener. Re-derives the card
	// from the server's OWN log (never trusts the client for the card's details) and
	// atomically claims that card row, so a re-swipe/refresh can't double-post.
	announceDrops: async ({ locals, request }) => {
		if (!locals.user) throw error(401, 'Sign in first');

		const form = await request.formData();
		const openId = form.get('open_id')?.toString();
		const cardId = form.get('card_id')?.toString();
		const finish = form.get('finish')?.toString() || 'normal';
		if (!openId || !cardId) return { ok: false };

		// One not-yet-announced rare line for this exact (open, card, finish) owned by
		// the caller. Embeds the pack name + card art needed to build the embed.
		const { data: row } = (await db()
			.from('vs_pack_open_cards')
			.select('id, card_name, rarity, finish, vs_cards(front_url, layers), vs_pack_opens(pack_name)')
			.eq('open_id', openId)
			.eq('user_id', locals.user.id)
			.eq('card_id', cardId)
			.eq('finish', finish)
			.in('rarity', RARE_RARITIES)
			.eq('announced', false)
			.limit(1)
			.maybeSingle()) as {
			data: {
				id: string;
				card_name: string;
				rarity: string;
				finish: CardFinish;
				vs_cards: { front_url: string | null; layers: unknown } | { front_url: string | null; layers: unknown }[] | null;
				vs_pack_opens: { pack_name: string | null } | { pack_name: string | null }[] | null;
			} | null;
		};
		if (!row) return { ok: true }; // not theirs / not rare / already announced

		// Claim it before posting (optimistic — loses the race ⇒ someone else posted).
		const { data: claimed } = await db()
			.from('vs_pack_open_cards')
			.update({ announced: true })
			.eq('id', row.id)
			.eq('announced', false)
			.select('id');
		if (!claimed || claimed.length === 0) return { ok: true };

		const cv = Array.isArray(row.vs_cards) ? row.vs_cards[0] : row.vs_cards;
		const po = Array.isArray(row.vs_pack_opens) ? row.vs_pack_opens[0] : row.vs_pack_opens;
		await postCardDrop({
			by: locals.user.rsn || locals.user.discord_username || 'Someone',
			rsn: locals.user.rsn,
			cardName: row.card_name,
			rarity: row.rarity,
			finish: row.finish,
			packName: po?.pack_name ?? '',
			imageUrl: cv?.front_url ?? null,
			layerUrls: toCardLayers(cv?.layers ?? []).map((l) => l.url)
		});
		return { ok: true };
	},

	// Paid gamba-crate open (spend VP → roll → grant → reveal). Mirrors the bot's
	// paid lootcrate: items + role allowed.
	openCrate: async ({ locals }) => {
		if (!locals.user) throw error(401, 'Sign in first');

		const config = await getLootConfig();
		// Respect the shared bot_config switch — paid opens can be turned off.
		if (!isPaidCrateEnabled(config)) {
			return fail(400, { crateError: 'Paid crate opens are currently disabled.' });
		}
		const cost = config.spinCost ?? 5;

		const spend = await spendPlayerVp(locals.user.discord_id, locals.user.rsn, cost);
		if (!spend.ok) {
			const msg =
				spend.reason === 'insufficient'
					? `Not enough VP — a crate costs ${cost.toLocaleString()} VP and you have ${spend.balance.toLocaleString()}.`
					: spend.reason === 'no_player'
						? 'No RuneScape player record is linked to your account, so you have no VP to spend.'
						: 'Could not open the crate — please try again.';
			return fail(400, { crateError: msg, balance: spend.balance });
		}

		const result = rollLoot(config, true, true);
		await applyCrateReward(locals.user, false, result);

		const balance = await getPlayerVp(locals.user.discord_id, locals.user.rsn);
		return { crateOk: true, reward: toCrateReward(result, false), balance, freeAvailable: undefined };
	},

	// Free daily gamba-crate claim (shared with Discord via players.last_loot_date).
	// Mirrors the bot's free claim: no role, items per config.freeDropItems.
	claimFreeCrate: async ({ locals }) => {
		if (!locals.user) throw error(401, 'Sign in first');

		const config = await getLootConfig();
		const todayUtc = new Date().toISOString().slice(0, 10);

		const claim = await claimFreeLootDay(locals.user.discord_id, locals.user.rsn, todayUtc);
		if (!claim.ok) {
			const msg =
				claim.reason === 'no_player'
					? 'No RuneScape player record is linked to your account.'
					: claim.reason === 'already'
						? "You've already claimed today's free crate — open one for VP, or come back when the timer resets."
						: 'Could not claim your free crate — please try again.';
			return fail(400, { crateError: msg, freeAvailable: claim.reason !== 'already' });
		}

		const allowItems = config.freeDropItems !== false;
		const result = rollLoot(config, allowItems, false);
		await applyCrateReward(locals.user, true, result);

		const balance = await getPlayerVp(locals.user.discord_id, locals.user.rsn);
		return { crateOk: true, reward: toCrateReward(result, true), balance, freeAvailable: false };
	}
};
