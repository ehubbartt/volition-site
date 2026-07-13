import { redirect, error, fail } from '@sveltejs/kit';
import { isAdmin } from '$lib/server/auth';
import itemEhb from '$lib/server/data/itemEhb.json';
import type { ItemEhb } from '$lib/ehb';
import {
	getEhbOverrides,
	setBossOverride,
	clearBossOverride,
	setItemOverride,
	clearItemOverride,
	getExcludedItemIds,
	setItemExclusion,
	clearItemExclusion
} from '$lib/server/ehbOverrides';
import type { Actions, PageServerLoad } from './$types';

// EXPERIMENTAL drop-difficulty tool. Ships raw per-source drop data; the page computes EHB
// live from editable assumptions (raid purple rates, ToA invocation, Doom floor) so
// raid/Doom variants can be explored. EHB math + types live in $lib/ehb (shared with the
// personal collection-log bingo generator). Admins can also pin manual overrides (a boss's
// rate, or a specific item's EHB) which layer on top of itemEhb.json — see ehbOverrides.ts.
const ITEMS = itemEhb as ItemEhb[];

// Distinct overridable bosses: every (mechanic, source) with a base rate `r`. Doom is
// excluded (it's driven by the doomKph assumption, not a per-source rate).
function bossSources() {
	const map = new Map<string, { mechanic: string; source_name: string; default_rate: number }>();
	for (const item of ITEMS) {
		for (const src of item.sources) {
			if (src.t === 'doom' || src.r == null) continue;
			const key = `${src.t}|${src.s}`;
			if (!map.has(key)) map.set(key, { mechanic: src.t, source_name: src.s, default_rate: src.r });
		}
	}
	return [...map.values()].sort((a, b) => a.source_name.localeCompare(b.source_name));
}

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) throw redirect(303, '/');
	if (!isAdmin(locals.user)) throw error(403, 'Not allowed');
	const excludedIds = await getExcludedItemIds(true);
	const nameById = new Map(ITEMS.map((i) => [i.id, i.name]));
	const excludedItems = [...excludedIds]
		.map((id) => ({ id, name: nameById.get(id) ?? `#${id}` }))
		.sort((a, b) => a.name.localeCompare(b.name));
	return {
		items: ITEMS,
		bossSources: bossSources(),
		overrides: await getEhbOverrides(true),
		excludedItems
	};
};

export const actions: Actions = {
	saveBossOverride: async ({ locals, request }) => {
		if (!locals.user || !isAdmin(locals.user)) throw error(403, 'Not allowed');
		const form = await request.formData();
		const mechanic = form.get('mechanic')?.toString() ?? '';
		const sourceName = form.get('source_name')?.toString() ?? '';
		const rate = Number(form.get('rate'));
		if (!mechanic || !sourceName) return fail(400, { error: 'Missing boss source' });
		if (!Number.isFinite(rate) || rate <= 0)
			return fail(400, { error: 'Rate must be a positive number (kills/raids per hour)' });
		const res = await setBossOverride(mechanic, sourceName, rate, locals.user.discord_id, form.get('note')?.toString() || undefined);
		return res.ok ? { ok: true, saved: 'boss' as const } : fail(500, { error: res.error });
	},

	deleteBossOverride: async ({ locals, request }) => {
		if (!locals.user || !isAdmin(locals.user)) throw error(403, 'Not allowed');
		const form = await request.formData();
		const mechanic = form.get('mechanic')?.toString() ?? '';
		const sourceName = form.get('source_name')?.toString() ?? '';
		if (!mechanic || !sourceName) return fail(400, { error: 'Missing boss source' });
		const res = await clearBossOverride(mechanic, sourceName);
		return res.ok ? { ok: true, cleared: 'boss' as const } : fail(500, { error: res.error });
	},

	saveItemOverride: async ({ locals, request }) => {
		if (!locals.user || !isAdmin(locals.user)) throw error(403, 'Not allowed');
		const form = await request.formData();
		const itemId = Number(form.get('item_id'));
		const ehbHours = Number(form.get('ehb_hours'));
		if (!Number.isFinite(itemId)) return fail(400, { error: 'Missing item' });
		if (!Number.isFinite(ehbHours) || ehbHours < 0)
			return fail(400, { error: 'EHB must be 0 or more (hours)' });
		const res = await setItemOverride(itemId, ehbHours, locals.user.discord_id, form.get('note')?.toString() || undefined);
		return res.ok ? { ok: true, saved: 'item' as const } : fail(500, { error: res.error });
	},

	deleteItemOverride: async ({ locals, request }) => {
		if (!locals.user || !isAdmin(locals.user)) throw error(403, 'Not allowed');
		const itemId = Number((await request.formData()).get('item_id'));
		if (!Number.isFinite(itemId)) return fail(400, { error: 'Missing item' });
		const res = await clearItemOverride(itemId);
		return res.ok ? { ok: true, cleared: 'item' as const } : fail(500, { error: res.error });
	},

	// Remove an item from the personal-board draw pool.
	excludeItem: async ({ locals, request }) => {
		if (!locals.user || !isAdmin(locals.user)) throw error(403, 'Not allowed');
		const itemId = Number((await request.formData()).get('item_id'));
		if (!Number.isFinite(itemId)) return fail(400, { error: 'Missing item' });
		const res = await setItemExclusion(itemId, locals.user.discord_id);
		return res.ok ? { ok: true, saved: 'exclude' as const } : fail(500, { error: res.error });
	},

	unexcludeItem: async ({ locals, request }) => {
		if (!locals.user || !isAdmin(locals.user)) throw error(403, 'Not allowed');
		const itemId = Number((await request.formData()).get('item_id'));
		if (!Number.isFinite(itemId)) return fail(400, { error: 'Missing item' });
		const res = await clearItemExclusion(itemId);
		return res.ok ? { ok: true, cleared: 'exclude' as const } : fail(500, { error: res.error });
	}
};

export type { EhbMechanic, EhbSource, ItemEhb } from '$lib/ehb';
