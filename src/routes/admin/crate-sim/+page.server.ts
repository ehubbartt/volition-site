import { redirect, error, fail } from '@sveltejs/kit';
import { isAdmin } from '$lib/server/auth';
import { getLootConfig, rollLoot, type LootConfig, type LootResult } from '$lib/server/lootcrate';
import { itemPrice } from '$lib/gp';
import type { Actions, PageServerLoad } from './$types';

// Loot-crate (gamba) simulator (dev/economy tool): rolls many PAID crate opens with
// the EXACT same logic as the real /gamba open (rollLoot, items + role allowed), but
// spends no VP and saves nothing. Two modes:
//   • count   — open exactly N crates.
//   • budget  — start with B VP and open until you can't afford another (pool < cost),
//               optionally REINVESTING the VP won back into the pool. Runs `trials`
//               independent runs to average how far a budget stretches.
// Reports VP/GP generated, the VP earned-back ratio, GP value per VP, and the
// per-tier / per-item drop breakdown. GP values come from ITEM_PRICES (src/lib/gp.ts).

const MAX_COUNT = 2_000_000;
const MAX_BUDGET = 50_000_000; // VP
const MAX_TRIALS = 2_000;
const TOTAL_CRATE_CAP = 20_000_000; // safety across all trials (bounds runtime)
const PER_TRIAL_CAP = 5_000_000; // safety per trial (reinvest can run long)

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) throw redirect(303, '/');
	if (!isAdmin(locals.user)) throw error(403, 'Not allowed');

	const config = await getLootConfig();
	const cost = Math.max(1, config.spinCost ?? 5);
	// Surface the config being simulated (cost, tiers, which items carry a known GP value).
	const items = config.items
		.filter((i) => i.enabled)
		.map((i) => ({ name: i.name, gp: itemPrice(i.name) }));
	const tiers = config.vpTiers.map((t) => ({
		label: t.label,
		min: t.min,
		max: t.max,
		chance: t.chance
	}));
	const roleLabel = config.roleReward?.enabled
		? config.roleReward.label ?? 'Role reward'
		: null;

	return {
		cost,
		items,
		tiers,
		roleLabel,
		maxCount: MAX_COUNT,
		maxBudget: MAX_BUDGET,
		maxTrials: MAX_TRIALS
	};
};

interface Tally {
	crates: number;
	vpWon: number;
	gpWon: number;
	nothing: number; // 0-VP results (junk)
	roleCount: number;
	itemCount: number;
	maxVp: number;
	tier: Map<string, { count: number; vp: number }>;
	item: Map<string, { count: number; gp: number }>;
}

function newTally(): Tally {
	return {
		crates: 0,
		vpWon: 0,
		gpWon: 0,
		nothing: 0,
		roleCount: 0,
		itemCount: 0,
		maxVp: 0,
		tier: new Map(),
		item: new Map()
	};
}

function record(t: Tally, r: LootResult): void {
	t.crates++;
	if (r.kind === 'vp') {
		t.vpWon += r.amount;
		if (r.amount === 0) t.nothing++;
		if (r.amount > t.maxVp) t.maxVp = r.amount;
		const e = t.tier.get(r.label) ?? { count: 0, vp: 0 };
		e.count++;
		e.vp += r.amount;
		t.tier.set(r.label, e);
	} else if (r.kind === 'item') {
		t.itemCount++;
		const name = r.itemName ?? '?';
		const gp = itemPrice(name);
		t.gpWon += gp;
		const e = t.item.get(name) ?? { count: 0, gp: 0 };
		e.count++;
		e.gp += gp;
		t.item.set(name, e);
	} else if (r.kind === 'role') {
		t.roleCount++;
	}
}

export const actions: Actions = {
	simulate: async ({ locals, request }) => {
		if (!locals.user || !isAdmin(locals.user)) throw error(403, 'Not allowed');

		const form = await request.formData();
		const modeRaw = form.get('mode')?.toString();
		const mode: 'count' | 'budget' = modeRaw === 'budget' ? 'budget' : 'count';
		const count = Math.floor(Number(form.get('count') ?? 0));
		const budget = Math.floor(Number(form.get('budget') ?? 0));
		const reinvest = form.get('reinvest') === '1';
		const trials = Math.max(1, Math.min(MAX_TRIALS, Math.floor(Number(form.get('trials') ?? 1)) || 1));

		const config: LootConfig = await getLootConfig();
		const cost = Math.max(1, config.spinCost ?? 5);

		if (mode === 'count') {
			if (!Number.isFinite(count) || count < 1) {
				return fail(400, { error: 'Enter how many crates to open' });
			}
			if (count > MAX_COUNT) {
				return fail(400, { error: `Max ${MAX_COUNT.toLocaleString()} crates at once` });
			}
		} else {
			if (!Number.isFinite(budget) || budget < cost) {
				return fail(400, { error: `Budget must be at least the ${cost} VP crate cost` });
			}
			if (budget > MAX_BUDGET) {
				return fail(400, { error: `Max ${MAX_BUDGET.toLocaleString()} VP budget` });
			}
		}

		const t = newTally();
		let truncated = false;

		// Per-trial "crates a budget sustained" + leftover (budget mode only).
		const sustained: number[] = [];
		const leftovers: number[] = [];

		if (mode === 'count') {
			for (let i = 0; i < count; i++) record(t, rollLoot(config, true, true));
		} else {
			let totalCrates = 0;
			for (let tr = 0; tr < trials; tr++) {
				if (totalCrates >= TOTAL_CRATE_CAP) {
					truncated = true;
					break;
				}
				let pool = budget;
				let cratesThis = 0;
				while (pool >= cost && cratesThis < PER_TRIAL_CAP && totalCrates < TOTAL_CRATE_CAP) {
					pool -= cost;
					const r = rollLoot(config, true, true);
					record(t, r);
					// Only VP can be reinvested — items/role aren't spendable on crates.
					if (reinvest && r.kind === 'vp') pool += r.amount;
					cratesThis++;
					totalCrates++;
				}
				if (pool >= cost) truncated = true; // hit a safety cap before depleting
				sustained.push(cratesThis);
				leftovers.push(pool);
			}
		}

		// ---- Ratios + headline metrics ----
		const crates = t.crates;
		const vpSpent = crates * cost;
		const returnRatio = vpSpent ? t.vpWon / vpSpent : 0; // VP won per VP spent
		const netVp = t.vpWon - vpSpent; // negative = your real VP cost
		const gpPerVpSpent = vpSpent ? t.gpWon / vpSpent : 0;
		const gpPerCrate = crates ? t.gpWon / crates : 0;
		const avgVpPerCrate = crates ? t.vpWon / crates : 0;
		const itemRate = crates ? t.itemCount / crates : 0;

		// Budget-mode aggregates.
		const sorted = [...sustained].sort((a, b) => a - b);
		const sum = (a: number[]) => a.reduce((s, x) => s + x, 0);
		const pctl = (p: number) =>
			sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] : 0;
		const avgSustained = sorted.length ? sum(sorted) / sorted.length : 0;
		const avgLeftover = leftovers.length ? sum(leftovers) / leftovers.length : 0;
		// In reinvest mode the VP all churns — the player's REAL outlay is what disappeared
		// from the pool (budget − leftover). GP per net VP = gold value yielded per VP truly spent.
		const netVpConsumed = mode === 'budget' ? trials * budget - sum(leftovers) : 0;
		const gpPerNetVp = netVpConsumed ? t.gpWon / netVpConsumed : 0;
		const cratesPerVpBudgeted = mode === 'budget' && budget ? avgSustained / budget : 0;

		// Completion curve (CDF) of crates-sustained across trials (budget mode).
		const cdf: { x: number; pct: number }[] = [];
		if (mode === 'budget' && sorted.length > 1) {
			const n = sorted.length;
			const maxX = Math.max(1, sorted[n - 1]);
			const POINTS = 80;
			let j = 0;
			for (let k = 0; k <= POINTS; k++) {
				const x = Math.round((maxX * k) / POINTS);
				while (j < n && sorted[j] <= x) j++;
				cdf.push({ x, pct: (j / n) * 100 });
			}
		}

		// ---- Breakdowns ----
		const pct = (n: number) => (crates ? (n / crates) * 100 : 0);
		const tierRows = config.vpTiers
			.map((tt) => {
				const e = t.tier.get(tt.label) ?? { count: 0, vp: 0 };
				return {
					label: tt.label,
					count: e.count,
					pct: pct(e.count),
					vp: e.vp,
					color: tt.color ? `#${tt.color}` : null
				};
			})
			.filter((r) => r.count > 0);

		const itemRows = [...t.item.entries()]
			.map(([name, e]) => ({
				name,
				count: e.count,
				pct: pct(e.count),
				gp: e.gp,
				eachGp: itemPrice(name)
			}))
			.sort((a, b) => b.gp - a.gp || b.count - a.count);

		return {
			ok: true,
			mode,
			reinvest,
			cost,
			crates,
			vpSpent,
			vpWon: t.vpWon,
			netVp,
			returnRatio,
			gpWon: t.gpWon,
			gpPerVpSpent,
			gpPerCrate,
			gpPerNetVp,
			avgVpPerCrate,
			maxVp: t.maxVp,
			nothing: t.nothing,
			itemCount: t.itemCount,
			itemRate,
			roleCount: t.roleCount,
			// budget mode
			budget: mode === 'budget' ? budget : 0,
			trials: mode === 'budget' ? trials : 0,
			avgSustained,
			minSustained: sorted.length ? sorted[0] : 0,
			medSustained: pctl(50),
			maxSustained: sorted.length ? sorted[sorted.length - 1] : 0,
			avgLeftover,
			netVpConsumed,
			cratesPerVpBudgeted,
			cdf,
			truncated,
			tierRows,
			itemRows
		};
	}
};
