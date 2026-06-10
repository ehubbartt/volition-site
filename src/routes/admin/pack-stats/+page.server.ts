import { redirect, error } from '@sveltejs/kit';
import { selectAll } from '$lib/server/db';
import { isCardTester } from '$lib/server/auth';
import { RARITIES, isValidRarity, DEFAULT_RARITY } from '$lib/cards/rarity';
import type { PageServerLoad } from './$types';

// Card-tester-gated player stats, built from the vs_pack_opens history log plus
// current inventory (vs_user_cards / vs_user_packs). Aggregation happens in JS —
// the card game's dataset is small (clan-scale), so a few full-table reads are
// cheaper and simpler than DB-side rollups.

interface OpenRow {
	user_id: string;
	pack_id: string | null;
	pack_name: string | null;
	cost_vp: number | null;
	card_count: number | null;
	opened_at: string;
}

interface OpenCardRow {
	rarity: string;
	finish: string;
}

interface UserCardRow {
	user_id: string;
	quantity: number | null;
	card_id: string;
}

interface UserPackRow {
	user_id: string;
	quantity: number | null;
}

interface UserRow {
	id: string;
	rsn: string | null;
	discord_username: string | null;
}

export interface PlayerStat {
	userId: string;
	name: string;
	rsn: string | null; // for the public-profile link (/u/[rsn]); null = no profile URL
	packsOpened: number;
	vpSpent: number;
	cardsPulled: number; // cards obtained from opens (lifetime)
	packsOwned: number; // unopened packs in inventory now
	cardsOwned: number; // total card quantity owned now
	uniqueCards: number; // distinct card designs owned now
	lastOpened: string | null;
}

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) throw redirect(303, '/');
	if (!isCardTester(locals.user)) throw error(403, 'Not allowed');

	// Page through every row (PostgREST caps a plain .select() at 1000) so the
	// rarity/SR pull counts and per-player totals reflect the FULL history, not just
	// the first 1000 rows — vs_pack_open_cards (≈5 rows/open) blows past 1000 fast.
	const [userRows, opens, openCards, cardRows, packRows] = await Promise.all([
		selectAll<UserRow>('vs_users', 'id, rsn, discord_username'),
		selectAll<OpenRow>('vs_pack_opens', 'user_id, pack_id, pack_name, cost_vp, card_count, opened_at'),
		selectAll<OpenCardRow>('vs_pack_open_cards', 'rarity, finish'),
		selectAll<UserCardRow>('vs_user_cards', 'user_id, quantity, card_id'),
		selectAll<UserPackRow>('vs_user_packs', 'user_id, quantity')
	]);

	// Display name + RSN per user id.
	const nameOf = new Map<string, string>();
	const rsnOf = new Map<string, string | null>();
	for (const u of userRows) {
		nameOf.set(u.id, u.rsn || u.discord_username || 'Unknown');
		rsnOf.set(u.id, u.rsn);
	}

	// Per-player aggregation. uniqueCards is tracked with a Set, collapsed to a
	// count at the end.
	const players = new Map<string, PlayerStat & { _unique: Set<string> }>();
	const ensure = (userId: string) => {
		let p = players.get(userId);
		if (!p) {
			p = {
				userId,
				name: nameOf.get(userId) ?? 'Unknown',
				rsn: rsnOf.get(userId) ?? null,
				packsOpened: 0,
				vpSpent: 0,
				cardsPulled: 0,
				packsOwned: 0,
				cardsOwned: 0,
				uniqueCards: 0,
				lastOpened: null,
				_unique: new Set<string>()
			};
			players.set(userId, p);
		}
		return p;
	};

	// Open headers → per-player lifetime activity + per-pack breakdown.
	const packBreak = new Map<string, { name: string; opens: number; vp: number; cards: number }>();
	let totalOpens = 0;
	let totalVpSpent = 0;
	let totalCardsPulled = 0;

	for (const o of opens) {
		const p = ensure(o.user_id);
		const vp = o.cost_vp ?? 0;
		const cc = o.card_count ?? 0;
		p.packsOpened += 1;
		p.vpSpent += vp;
		p.cardsPulled += cc;
		if (!p.lastOpened || o.opened_at > p.lastOpened) p.lastOpened = o.opened_at;

		totalOpens += 1;
		totalVpSpent += vp;
		totalCardsPulled += cc;

		const key = o.pack_id ?? o.pack_name ?? 'unknown';
		const pb = packBreak.get(key) ?? { name: o.pack_name ?? 'Unknown pack', opens: 0, vp: 0, cards: 0 };
		pb.opens += 1;
		pb.vp += vp;
		pb.cards += cc;
		packBreak.set(key, pb);
	}

	// Line items → the rarity / finish pull breakdown.
	const rarityPulls: Record<string, number> = {};
	const finishPulls = { normal: 0, holo: 0, reverse: 0 };
	for (const c of openCards) {
		const r = isValidRarity(c.rarity) ? c.rarity : DEFAULT_RARITY;
		rarityPulls[r] = (rarityPulls[r] ?? 0) + 1;
		if (c.finish === 'holo') finishPulls.holo += 1;
		else if (c.finish === 'reverse') finishPulls.reverse += 1;
		else finishPulls.normal += 1;
	}

	// Current inventory.
	for (const c of cardRows) {
		const p = ensure(c.user_id);
		p.cardsOwned += c.quantity ?? 0;
		p._unique.add(c.card_id);
	}
	for (const up of packRows) {
		const p = ensure(up.user_id);
		p.packsOwned += up.quantity ?? 0;
	}

	const playerStats: PlayerStat[] = [...players.values()]
		.map(({ _unique, ...p }) => ({ ...p, uniqueCards: _unique.size }))
		.sort(
			(a, b) =>
				b.packsOpened - a.packsOpened ||
				b.cardsOwned - a.cardsOwned ||
				a.name.localeCompare(b.name)
		);

	// Rarity breakdown in rarity order, dropping rarities never pulled.
	const rarityBreak = RARITIES.map((r) => ({
		key: r.key,
		label: r.label,
		color: r.color,
		count: rarityPulls[r.key] ?? 0
	})).filter((r) => r.count > 0);

	const packBreakdown = [...packBreak.values()].sort((a, b) => b.opens - a.opens);

	return {
		totals: {
			opens: totalOpens,
			vpSpent: totalVpSpent,
			cardsPulled: totalCardsPulled,
			openers: playerStats.filter((p) => p.packsOpened > 0).length
		},
		rarityBreak,
		finishPulls,
		packBreakdown,
		playerStats
	};
};
