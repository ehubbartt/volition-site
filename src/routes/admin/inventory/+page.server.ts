import { redirect, error, fail } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { isSuperAdmin } from '$lib/server/auth';
import type { Actions, PageServerLoad } from './$types';

// Super-admin Player Inventory tool: view a player's card collection + unopened packs
// and remove individual entries or wipe the whole inventory. Destructive + keyed to
// vs_users (only site-account players have card inventories), so isSuperAdmin-gated.
// Lives in the Database panel; writes go through form actions (auto-audited via hooks).

export type InvPlayer = {
	id: string;
	rsn: string | null;
	discord_username: string | null;
	discord_id: string | null;
	hasInventory: boolean;
};

export type InvCard = {
	id: string; // vs_user_cards row id
	card_id: string;
	finish: string;
	quantity: number;
	name: string;
	rarity: string;
	front_url: string | null;
};

export type InvPack = {
	id: string; // vs_user_packs row id
	pack_id: string;
	quantity: number;
	name: string;
	front_url: string | null;
};

export const load: PageServerLoad = async ({ locals, url }) => {
	if (!locals.user) throw redirect(303, '/');
	if (!isSuperAdmin(locals.user)) throw error(403, 'Not allowed');

	const userId = url.searchParams.get('user');

	const [{ data: users }, { data: cardOwners }, { data: packOwners }] = await Promise.all([
		db().from('vs_users').select('id, rsn, discord_username, discord_id').order('rsn', { ascending: true }),
		db().from('vs_user_cards').select('user_id'),
		db().from('vs_user_packs').select('user_id')
	]);

	const withInv = new Set<string>([
		...((cardOwners ?? []) as Array<{ user_id: string }>).map((r) => String(r.user_id)),
		...((packOwners ?? []) as Array<{ user_id: string }>).map((r) => String(r.user_id))
	]);

	const players: InvPlayer[] = ((users ?? []) as Array<{
		id: string;
		rsn: string | null;
		discord_username: string | null;
		discord_id: string | null;
	}>).map((u) => ({ ...u, hasInventory: withInv.has(String(u.id)) }));

	let selected: InvPlayer | null = null;
	let cards: InvCard[] = [];
	let packs: InvPack[] = [];

	if (userId) {
		selected = players.find((p) => p.id === userId) ?? null;
		if (selected) {
			const [{ data: c }, { data: p }] = await Promise.all([
				db()
					.from('vs_user_cards')
					.select('id, card_id, finish, quantity, vs_cards(name, rarity, front_url)')
					.eq('user_id', userId)
					.order('first_acquired_at', { ascending: false }),
				db()
					.from('vs_user_packs')
					.select('id, pack_id, quantity, vs_card_packs(name, front_url)')
					.eq('user_id', userId)
					.order('updated_at', { ascending: false })
			]);

			cards = ((c ?? []) as unknown as Array<{
				id: string;
				card_id: string;
				finish: string;
				quantity: number;
				vs_cards: { name: string; rarity: string; front_url: string | null } | null;
			}>).map((row) => ({
				id: row.id,
				card_id: row.card_id,
				finish: row.finish ?? 'normal',
				quantity: row.quantity ?? 0,
				name: row.vs_cards?.name ?? '(deleted card)',
				rarity: row.vs_cards?.rarity ?? 'bronze',
				front_url: row.vs_cards?.front_url ?? null
			}));

			packs = ((p ?? []) as unknown as Array<{
				id: string;
				pack_id: string;
				quantity: number;
				vs_card_packs: { name: string; front_url: string | null } | null;
			}>).map((row) => ({
				id: row.id,
				pack_id: row.pack_id,
				quantity: row.quantity ?? 0,
				name: row.vs_card_packs?.name ?? '(deleted pack)',
				front_url: row.vs_card_packs?.front_url ?? null
			}));
		}
	}

	const totals = {
		cardStacks: cards.length,
		cardCopies: cards.reduce((s, c) => s + c.quantity, 0),
		packStacks: packs.length,
		packCopies: packs.reduce((s, p) => s + p.quantity, 0)
	};

	return { players, selected, cards, packs, totals };
};

function guard(locals: App.Locals) {
	if (!locals.user) throw redirect(303, '/');
	if (!isSuperAdmin(locals.user)) return false;
	return true;
}

export const actions: Actions = {
	// Remove a single card entry (one (card, finish) stack) from a player.
	removeCard: async ({ locals, request }) => {
		if (!guard(locals)) return fail(403, { error: 'Not allowed' });
		const form = await request.formData();
		const id = form.get('id')?.toString();
		const userId = form.get('user_id')?.toString();
		if (!id || !userId) return fail(400, { error: 'Missing id/user' });
		const { error: e } = await db().from('vs_user_cards').delete().eq('id', id).eq('user_id', userId);
		if (e) return fail(500, { error: e.message });
		return { ok: true, op: 'removeCard' };
	},

	// Remove a single unopened-pack entry from a player.
	removePack: async ({ locals, request }) => {
		if (!guard(locals)) return fail(403, { error: 'Not allowed' });
		const form = await request.formData();
		const id = form.get('id')?.toString();
		const userId = form.get('user_id')?.toString();
		if (!id || !userId) return fail(400, { error: 'Missing id/user' });
		const { error: e } = await db().from('vs_user_packs').delete().eq('id', id).eq('user_id', userId);
		if (e) return fail(500, { error: e.message });
		return { ok: true, op: 'removePack' };
	},

	// Wipe ALL cards (every (card, finish) stack) from a player.
	wipeCards: async ({ locals, request }) => {
		if (!guard(locals)) return fail(403, { error: 'Not allowed' });
		const form = await request.formData();
		const userId = form.get('user_id')?.toString();
		if (!userId) return fail(400, { error: 'Missing user' });
		const { error: e } = await db().from('vs_user_cards').delete().eq('user_id', userId);
		if (e) return fail(500, { error: e.message });
		return { ok: true, op: 'wipeCards' };
	},

	// Wipe ALL unopened packs from a player.
	wipePacks: async ({ locals, request }) => {
		if (!guard(locals)) return fail(403, { error: 'Not allowed' });
		const form = await request.formData();
		const userId = form.get('user_id')?.toString();
		if (!userId) return fail(400, { error: 'Missing user' });
		const { error: e } = await db().from('vs_user_packs').delete().eq('user_id', userId);
		if (e) return fail(500, { error: e.message });
		return { ok: true, op: 'wipePacks' };
	}
};
