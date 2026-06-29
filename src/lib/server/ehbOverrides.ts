// SERVER-ONLY: admin-set manual EHB corrections (vs_ehb_overrides), layered on top of the
// computed values from itemEhb.json. EHB is an estimate; admins fix a boss's rate (affects
// all its drops) or pin a specific item's EHB. Cached ~60s like rankConfig/getLootConfig.
//
// Shape returned to the math (src/lib/ehb.ts EhbOverrides):
//   bossRate: `${mechanic}|${source_name}` → kills/raids per hour
//   itemEhb:  item_id → final EHB hours

import { db } from './db';
import { bossKey, type EhbOverrides, type EhbMechanic } from '$lib/ehb';

// A boss override as stored, for the admin editor (so it can list/clear active ones).
export interface BossOverrideRow {
	mechanic: EhbMechanic;
	source_name: string;
	rate: number;
	note: string | null;
}
export interface ItemOverrideRow {
	item_id: number;
	ehb_hours: number;
	note: string | null;
}

let cache: { value: EhbOverrides; at: number } | null = null;
let inflight: Promise<EhbOverrides> | null = null;
const CACHE_TTL_MS = 60_000;

function bustCache() {
	cache = null;
	inflight = null;
}

// The override map for the EHB math, cached for a minute. force=true bypasses the cache so
// an admin's edit applies immediately. Never throws (missing table → empty overrides).
export async function getEhbOverrides(force = false): Promise<EhbOverrides> {
	if (!force && cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.value;
	if (!force && inflight) return inflight;

	const load = (async (): Promise<EhbOverrides> => {
		const empty: EhbOverrides = { bossRate: {}, itemEhb: {} };
		try {
			const { data } = await db()
				.from('vs_ehb_overrides')
				.select('kind, mechanic, source_name, rate, item_id, ehb_hours');
			const out: EhbOverrides = { bossRate: {}, itemEhb: {} };
			for (const r of (data ?? []) as {
				kind: string;
				mechanic: string | null;
				source_name: string | null;
				rate: number | null;
				item_id: number | null;
				ehb_hours: number | null;
			}[]) {
				if (r.kind === 'boss' && r.mechanic && r.source_name && r.rate != null && r.rate > 0) {
					out.bossRate[bossKey({ t: r.mechanic as EhbMechanic, s: r.source_name })] = r.rate;
				} else if (r.kind === 'item' && r.item_id != null && r.ehb_hours != null && r.ehb_hours >= 0) {
					out.itemEhb[r.item_id] = r.ehb_hours;
				}
			}
			cache = { value: out, at: Date.now() };
			return out;
		} catch {
			return empty;
		}
	})();

	if (!force) inflight = load;
	try {
		return await load;
	} finally {
		if (inflight === load) inflight = null;
	}
}

// Full rows for the admin editor (so it can show + clear what's active).
export async function listEhbOverrides(): Promise<{ boss: BossOverrideRow[]; item: ItemOverrideRow[] }> {
	const { data } = await db()
		.from('vs_ehb_overrides')
		.select('kind, mechanic, source_name, rate, item_id, ehb_hours, note');
	const boss: BossOverrideRow[] = [];
	const item: ItemOverrideRow[] = [];
	for (const r of (data ?? []) as Record<string, unknown>[]) {
		if (r.kind === 'boss') {
			boss.push({ mechanic: r.mechanic as EhbMechanic, source_name: String(r.source_name), rate: Number(r.rate), note: (r.note as string) ?? null });
		} else if (r.kind === 'item') {
			item.push({ item_id: Number(r.item_id), ehb_hours: Number(r.ehb_hours), note: (r.note as string) ?? null });
		}
	}
	boss.sort((a, b) => a.source_name.localeCompare(b.source_name));
	item.sort((a, b) => a.item_id - b.item_id);
	return { boss, item };
}

export async function setBossOverride(
	mechanic: string,
	sourceName: string,
	rate: number,
	updatedBy: string,
	note?: string
): Promise<{ ok: boolean; error?: string }> {
	const { error } = await db()
		.from('vs_ehb_overrides')
		.upsert(
			{ kind: 'boss', mechanic, source_name: sourceName, rate, note: note ?? null, updated_by: updatedBy, updated_at: new Date().toISOString() },
			{ onConflict: 'mechanic,source_name' }
		);
	bustCache();
	return error ? { ok: false, error: error.message } : { ok: true };
}

export async function clearBossOverride(mechanic: string, sourceName: string): Promise<{ ok: boolean; error?: string }> {
	const { error } = await db()
		.from('vs_ehb_overrides')
		.delete()
		.eq('kind', 'boss')
		.eq('mechanic', mechanic)
		.eq('source_name', sourceName);
	bustCache();
	return error ? { ok: false, error: error.message } : { ok: true };
}

export async function setItemOverride(
	itemId: number,
	ehbHours: number,
	updatedBy: string,
	note?: string
): Promise<{ ok: boolean; error?: string }> {
	const { error } = await db()
		.from('vs_ehb_overrides')
		.upsert(
			{ kind: 'item', item_id: itemId, ehb_hours: ehbHours, note: note ?? null, updated_by: updatedBy, updated_at: new Date().toISOString() },
			{ onConflict: 'item_id' }
		);
	bustCache();
	return error ? { ok: false, error: error.message } : { ok: true };
}

export async function clearItemOverride(itemId: number): Promise<{ ok: boolean; error?: string }> {
	const { error } = await db().from('vs_ehb_overrides').delete().eq('kind', 'item').eq('item_id', itemId);
	bustCache();
	return error ? { ok: false, error: error.message } : { ok: true };
}
