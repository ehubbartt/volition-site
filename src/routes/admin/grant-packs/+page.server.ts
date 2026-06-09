import { redirect, error, fail } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { isCardTester } from '$lib/server/auth';
import { grantUserPack } from '$lib/server/gamba';
import type { Actions, PageServerLoad } from './$types';

// Admin tool to manually award card packs to members. Packs go to vs_user_packs,
// whose user_id is an FK to vs_users — so only members who've SIGNED INTO THE SITE
// can receive packs (the bot's `players` roster alone isn't enough). Card-tester
// gated, like the rest of the card-game admin.

const MAX_QTY = 100;

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) throw redirect(303, '/');
	if (!isCardTester(locals.user)) throw error(403, 'Not allowed');

	const [packsRes, membersRes] = await Promise.all([
		// All packs (incl. unreleased — e.g. a granted-only set).
		db().from('vs_card_packs').select('id, name, released').order('name', { ascending: true }),
		// Everyone with a site profile (the only grantable targets).
		db().from('vs_users').select('id, rsn, discord_username').order('rsn', { ascending: true })
	]);
	if (packsRes.error) throw error(500, packsRes.error.message);
	if (membersRes.error) throw error(500, membersRes.error.message);

	return {
		packs: packsRes.data ?? [],
		members: membersRes.data ?? []
	};
};

export const actions: Actions = {
	grantPacks: async ({ locals, request }) => {
		if (!locals.user || !isCardTester(locals.user)) throw error(403, 'Not allowed');

		const form = await request.formData();
		const packId = form.get('pack_id')?.toString();
		const target = form.get('target')?.toString(); // 'one' | 'all'
		const userId = form.get('user_id')?.toString();
		const qty = Math.floor(Number(form.get('quantity') ?? 1));

		if (!packId) return fail(400, { error: 'Pick a pack.' });
		if (!Number.isFinite(qty) || qty < 1 || qty > MAX_QTY) {
			return fail(400, { error: `Quantity must be between 1 and ${MAX_QTY}.` });
		}

		// Pack must exist (released or not — admins can grant unreleased sets).
		const { data: pack, error: pErr } = await db()
			.from('vs_card_packs')
			.select('id, name')
			.eq('id', packId)
			.maybeSingle();
		if (pErr) return fail(500, { error: pErr.message });
		if (!pack) return fail(404, { error: 'That pack no longer exists.' });

		const plural = qty === 1 ? 'pack' : 'packs';

		// ── Award to ONE member ──────────────────────────────────────────────
		if (target !== 'all') {
			if (!userId) return fail(400, { error: 'Pick a member (or choose Everyone).' });
			const { data: member, error: mErr } = await db()
				.from('vs_users')
				.select('id, rsn, discord_username')
				.eq('id', userId)
				.maybeSingle();
			if (mErr) return fail(500, { error: mErr.message });
			if (!member) return fail(404, { error: 'That member no longer exists.' });

			const ok = await grantUserPack(userId, packId, qty);
			if (!ok) return fail(500, { error: 'Could not award the pack — please try again.' });

			const who = member.rsn || member.discord_username || 'that member';
			return { ok: true, message: `Awarded ${qty} ${pack.name} ${plural} to ${who}.` };
		}

		// ── Award to EVERYONE (all site members) ─────────────────────────────
		const { data: users, error: uErr } = await db().from('vs_users').select('id');
		if (uErr) return fail(500, { error: uErr.message });
		const ids = (users ?? []).map((u) => u.id);
		if (ids.length === 0) return fail(400, { error: 'There are no site members to award to.' });

		// Read existing quantities for this pack so the upsert (which SETS quantity)
		// adds to what each member already has instead of overwriting it.
		const { data: existing, error: eErr } = await db()
			.from('vs_user_packs')
			.select('user_id, quantity')
			.eq('pack_id', packId);
		if (eErr) return fail(500, { error: eErr.message });
		const have = new Map<string, number>();
		for (const r of existing ?? []) have.set(r.user_id as string, (r.quantity as number) ?? 0);

		const now = new Date().toISOString();
		const rows = ids.map((id) => ({
			user_id: id,
			pack_id: packId,
			quantity: (have.get(id) ?? 0) + qty,
			updated_at: now
		}));
		const { error: upErr } = await db()
			.from('vs_user_packs')
			.upsert(rows, { onConflict: 'user_id,pack_id' });
		if (upErr) return fail(500, { error: upErr.message });

		return { ok: true, message: `Awarded ${qty} ${pack.name} ${plural} to all ${ids.length} members.` };
	}
};
