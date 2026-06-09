import { redirect, error, fail } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { isCardTester, type SessionUser } from '$lib/server/auth';
import {
	getPlayerVp,
	spendPlayerVp,
	grantPlayerVp,
	claimFreeLootDay,
	getLastLootDate
} from '$lib/server/playerStats';
import { grantCards, logPackOpen, makeSlotRoller, rollOnePack, type CardGrant } from '$lib/server/gamba';
import { getLootConfig, rollLoot, type LootConfig, type LootResult } from '$lib/server/lootcrate';
import { logLootcrateOpen } from '$lib/server/lootcrateAnalytics';
import { sendBotMessage } from '$lib/server/botBridge';
import { isValidRarity, DEFAULT_RARITY, RARE_RARITIES, toCardLayers, type Card, type CardAbility, type CardLayer, type CardRarity } from '$lib/cards/rarity';
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
	sound_url: string | null;
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

export interface CrateInfo {
	spinCost: number;
	freeAvailable: boolean;
	odds: CrateOdd[];
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

// Player-facing pack store. Gated to card testers for now (CARD_TESTER_DISCORD_IDS)
// while the card game is in progress — flip this to "any logged-in user" to launch.
export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) throw redirect(303, '/');
	if (!isCardTester(locals.user)) throw error(403, 'Not allowed');

	const [vp_balance, packsRes, cardsRes, raresRes, lastLootDate, lootConfig, crateDropsRes] = await Promise.all([
		getPlayerVp(locals.user.discord_id, locals.user.rsn),
		db()
			.from('vs_card_packs')
			.select('id, name, description, cost_vp, cards_per_pack, front_url, back_url')
			.eq('released', true)
			.order('cost_vp', { ascending: true }),
		db().from('vs_cards').select('pack_id'),
		// Recently opened rares (rune+), newest first — the live drop ticker. Reads
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
			.limit(50)
	]);

	if (packsRes.error) throw error(500, packsRes.error.message);

	// Gamba crate (shared lootcrate) — odds + free-claim availability.
	const todayUtc = new Date().toISOString().slice(0, 10);
	const crate: CrateInfo = {
		spinCost: lootConfig.spinCost ?? 5,
		freeAvailable: lastLootDate !== todayUtc,
		odds: [
			...lootConfig.vpTiers.map((t) => ({ label: t.label, pct: t.chance, color: `#${t.color ?? '808080'}` })),
			{ label: 'Rare item', pct: lootConfig.itemDropChance, color: '#00ff7b' },
			...(lootConfig.roleReward?.enabled
				? [{ label: lootConfig.roleReward.label ?? 'Role', pct: lootConfig.roleReward.chance, color: `#${lootConfig.roleReward.color ?? '800080'}` }]
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

	// How many cards each set has, so we can flag/disable empty packs.
	const counts = new Map<string, number>();
	for (const r of cardsRes.data ?? []) {
		if (r.pack_id) counts.set(r.pack_id, (counts.get(r.pack_id) ?? 0) + 1);
	}

	const packs = (packsRes.data ?? []).map((p) => ({
		...p,
		card_count: counts.get(p.id) ?? 0
	}));

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

	return { vp_balance, packs, recentRares, crate, recentCrateDrops };
};

export const actions: Actions = {
	open: async ({ locals, request }) => {
		if (!locals.user || !isCardTester(locals.user)) throw error(403, 'Not allowed');

		const form = await request.formData();
		const packId = form.get('pack_id')?.toString();
		if (!packId) return fail(400, { error: 'Missing pack' });

		// Pack must exist AND be released.
		const { data: pack, error: pErr } = await db()
			.from('vs_card_packs')
			.select('id, name, cost_vp, cards_per_pack, rarity_weights, slot_weights, slot_finishes, front_url, back_url, released, holo_regular_url, holo_reverse_url')
			.eq('id', packId)
			.maybeSingle();
		if (pErr) return fail(500, { error: pErr.message });
		if (!pack || !pack.released) return fail(404, { error: 'That pack is not available.' });

		// Card pool for this set.
		const { data: poolRows, error: poolErr } = await db()
			.from('vs_cards')
			.select('id, name, level, rarity, abilities, flavor, front_url, back_url, layers, full_art, holo_url, sound_url')
			.eq('pack_id', packId);
		if (poolErr) return fail(500, { error: poolErr.message });
		const pool = (poolRows ?? []) as CardRow[];
		if (pool.length === 0) return fail(400, { error: 'This pack has no cards yet.' });
		// Normalize legacy/invalid rarities so they group + weight correctly. A card
		// whose stored rarity isn't a current key shows as Bronze in admin (fallback)
		// but would otherwise form its own 0-weight group in the roller and never drop.
		for (const c of pool) if (!isValidRarity(c.rarity)) c.rarity = DEFAULT_RARITY;

		const cost = pack.cost_vp ?? 0;
		const n = Math.max(1, pack.cards_per_pack ?? 5);

		// Roll the pack — shared logic with the admin simulator (see gamba.ts) so the
		// odds match: per-slot rarity weights, slot/rarest-last order, and the
		// positional Holo / Reverse-Holo finishes (full-art cards stay Normal).
		const pick = makeSlotRoller(pool);
		const rolled = rollOnePack<CardRow>(pick, {
			cardsPerPack: n,
			slotWeights: (Array.isArray(pack.slot_weights) ? pack.slot_weights : []) as Record<
				string,
				number
			>[],
			rarityWeights: (pack.rarity_weights as Record<string, number> | null) ?? null,
			slotFinishes: (Array.isArray(pack.slot_finishes) ? pack.slot_finishes : []) as {
				holo: number;
				reverse: number;
			}[]
		});

		// 1) Spend VP (optimistic — only if affordable and unchanged).
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

		// 2) Grant the cards (each card + finish is a separate inventory entry). If
		// that fails, refund the VP.
		const grants: CardGrant[] = rolled.map((r) => ({ card_id: r.card.id, finish: r.finish }));
		const grant = await grantCards(locals.user.id, grants);
		if (!grant.ok) {
			await grantPlayerVp(locals.user.discord_id, locals.user.rsn, cost);
			return fail(500, { error: 'Could not add the cards to your collection — your VP was refunded.' });
		}

		// 3) Log the open — header + one line per card (powers player stats and the
		// rare-pull feed). Best-effort: never undoes the already-completed open.
		await logPackOpen({
			userId: locals.user.id,
			packId: pack.id,
			packName: pack.name,
			costVp: cost,
			cards: rolled.map((r) => ({
				card_id: r.card.id,
				card_name: r.card.name,
				rarity: r.card.rarity,
				finish: r.finish
			}))
		});

		const opened: (Card & { finish: CardFinish })[] = rolled.map((r) => ({
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
			sound_url: r.card.sound_url,
			holo_regular_url: (pack.holo_regular_url as string | null) ?? null,
			holo_reverse_url: (pack.holo_reverse_url as string | null) ?? null,
			finish: r.finish
		}));

		return {
			ok: true,
			opened,
			pack: { name: pack.name, front_url: pack.front_url, back_url: pack.back_url },
			balance: spend.balance
		};
	},

	// Paid gamba-crate open (spend VP → roll → grant → reveal). Mirrors the bot's
	// paid lootcrate: items + role allowed.
	openCrate: async ({ locals }) => {
		if (!locals.user || !isCardTester(locals.user)) throw error(403, 'Not allowed');

		const config = await getLootConfig();
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
		if (!locals.user || !isCardTester(locals.user)) throw error(403, 'Not allowed');

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
