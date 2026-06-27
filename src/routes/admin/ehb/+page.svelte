<script lang="ts">
	import type { PageData } from './$types';
	import { ehbOf, DOOM_FLOORS, formatEhb as fmt, type EhbSource, type EhbAssumptions } from '$lib/ehb';

	let { data }: { data: PageData } = $props();

	// ── Editable assumptions ────────────────────────────────────────────────
	// Per-raid purple chance entered as "1 / N". Raid uniques in the data are a
	// share of the purple table, so EHB = expectedPurples × N / raidsPerHour.
	let coxN = $state(28.7); // CoX purple ≈ 1/28.7 (points-dependent)
	let tobnN = $state(9.1); // ToB normal ≈ 1/9.1
	let tobhN = $state(8.6); // ToB hard ≈ 1/8.6

	// ToA per-raid purple chance by invocation/raid level (≈, editable via the preset).
	const TOA_PRESETS: Record<number, number> = { 150: 24, 200: 20.7, 300: 13.6, 350: 11.7, 400: 10.6, 500: 8.6, 540: 8.3 };
	let toaInvo = $state(300);
	let toaN = $state(TOA_PRESETS[300]);
	function setInvo(v: number) {
		toaInvo = v;
		if (TOA_PRESETS[v] != null) toaN = TOA_PRESETS[v];
	}

	let doomFloor = $state(8);
	let doomKph = $state(18); // floor-8 clears/hr (WOM ironman EHB)

	// EHB rates are max-efficiency. This scales the resulting hours: 1 = max
	// efficiency, >1 = more chill (slower play → more hours), <1 = sweatier.
	let effMult = $state(1);

	// The shared EHB math (src/lib/ehb.ts) takes the assumptions as an argument.
	let assumptions = $derived<EhbAssumptions>({ coxN, tobnN, tobhN, toaN, doomFloor, doomKph, effMult });

	function sourceLabel(src: EhbSource): string {
		if (src.t === 'doom') return `Doom of Mokhaiotl (floor ${doomFloor})`;
		return src.s;
	}

	type Computed = { src: EhbSource; ehb: number; label: string };
	function computedSources(item: { sources: EhbSource[] }): Computed[] {
		return item.sources
			.map((src) => ({ src, ehb: ehbOf(src, assumptions), label: sourceLabel(src) }))
			.filter((c): c is Computed => c.ehb != null && isFinite(c.ehb))
			.sort((a, b) => a.ehb - b.ehb);
	}

	// ── Item lookup ───────────────────────────────────────────────────────────
	let query = $state('');
	const lookup = $derived.by(() => {
		const q = query.trim().toLowerCase();
		if (q.length < 2) return [];
		return data.items.filter((i) => i.name.toLowerCase().includes(q)).slice(0, 40);
	});

	// ── EHB target filter ──────────────────────────────────────────────────────
	let target = $state(20);
	let tolerance = $state(5);
	const matches = $derived.by(() => {
		const lo = target - tolerance;
		const hi = target + tolerance;
		const rows: { item: (typeof data.items)[number]; ehb: number; via: string }[] = [];
		for (const item of data.items) {
			const cs = computedSources(item);
			if (!cs.length) continue;
			const best = cs[0];
			if (best.ehb >= lo && best.ehb <= hi) rows.push({ item, ehb: best.ehb, via: best.label });
		}
		return rows.sort((a, b) => Math.abs(a.ehb - target) - Math.abs(b.ehb - target)).slice(0, 150);
	});
</script>

<svelte:head><title>EHB Drop Tool · Admin</title></svelte:head>

<section class="ehb">
	<a class="back" href="/admin/events">← Events</a>
	<h1>EHB Drop Tool <span class="exp">experimental</span></h1>
	<p class="muted">
		<strong>EHB per item</strong> = expected kills/raids to get the drop ÷ the boss's
		<a href="https://wiseoldman.net/ehb/iron" target="_blank" rel="noreferrer">WiseOldMan ironman EHB rate</a>.
		Drop rates from <a href="https://github.com/pairofcrocs/drop-rates-clog" target="_blank" rel="noreferrer">drop-rates-clog</a>,
		Doom per-floor rates from the <a href="https://github.com/Speaax/Delve-calculator" target="_blank" rel="noreferrer">Delve calculator</a>,
		names from the RuneLite cache. {data.items.length} items.
	</p>

	<!-- Assumptions -->
	<details class="card" open>
		<summary><strong>Assumptions</strong> <span class="muted small">— raid uniques are a share of the purple table, so these gate the EHB. Tune freely.</span></summary>
		<div class="assumptions">
			<label title="Scales all EHB: 1 = max efficiency, >1 = chill/slower (more hours), <1 = sweatier">
				<span>Efficiency ×</span><input type="number" min="0.1" step="0.1" bind:value={effMult} />
			</label>
			<label><span>CoX purple 1/</span><input type="number" min="1" step="0.1" bind:value={coxN} /></label>
			<label><span>ToB (normal) purple 1/</span><input type="number" min="1" step="0.1" bind:value={tobnN} /></label>
			<label><span>ToB (hard) purple 1/</span><input type="number" min="1" step="0.1" bind:value={tobhN} /></label>
			<label>
				<span>ToA invocation</span>
				<select value={toaInvo} onchange={(e) => setInvo(Number(e.currentTarget.value))}>
					{#each Object.keys(TOA_PRESETS).map(Number) as lvl}<option value={lvl}>{lvl} (1/{TOA_PRESETS[lvl]})</option>{/each}
				</select>
			</label>
			<label><span>ToA purple 1/</span><input type="number" min="1" step="0.1" bind:value={toaN} /></label>
			<label>
				<span>Doom floor</span>
				<select bind:value={doomFloor}>
					{#each [2, 3, 4, 5, 6, 7, 8, 9] as f}<option value={f}>{f === 9 ? '8+' : f}</option>{/each}
				</select>
			</label>
			<label><span>Doom clears/hr</span><input type="number" min="1" step="0.5" bind:value={doomKph} /></label>
		</div>
	</details>

	<div class="grid">
		<!-- Lookup -->
		<div class="card">
			<h2>Item lookup</h2>
			<input type="text" placeholder="Search item name…" bind:value={query} />
			{#if query.trim().length >= 2}
				{#if lookup.length === 0}
					<p class="muted small">No EHB-trackable item matches “{query}”.</p>
				{:else}
					<table>
						<thead><tr><th>Item</th><th>Source</th><th>Drop rate</th><th>EHB</th></tr></thead>
						<tbody>
							{#each lookup as i (i.id)}
								{@const cs = computedSources(i)}
								{#each cs as c, idx (c.src.s + c.src.t)}
									<tr>
										<td>{idx === 0 ? i.name : ''}</td>
										<td>{c.label}</td>
										<td>{c.src.t === 'doom' ? `1/${Math.round(1 / DOOM_FLOORS[doomFloor][c.src.col!])}` : c.src.rate}</td>
										<td class="ehb">{fmt(c.ehb)}</td>
									</tr>
								{/each}
							{/each}
						</tbody>
					</table>
				{/if}
			{/if}
		</div>

		<!-- Target filter -->
		<div class="card">
			<h2>Find drops by EHB target</h2>
			<div class="controls">
				<label><span>Target EHB (h)</span><input type="number" min="0" step="0.5" bind:value={target} /></label>
				<label><span>± tolerance</span><input type="number" min="0" step="0.5" bind:value={tolerance} /></label>
			</div>
			<p class="muted small">{matches.length} item{matches.length === 1 ? '' : 's'} within {fmt(Math.max(0, target - tolerance))}–{fmt(target + tolerance)} (cheapest source).</p>
			<table>
				<thead><tr><th>Item</th><th>EHB</th><th>Via</th></tr></thead>
				<tbody>
					{#each matches as m (m.item.id)}
						<tr><td>{m.item.name}</td><td class="ehb">{fmt(m.ehb)}</td><td>{m.via}</td></tr>
					{/each}
				</tbody>
			</table>
		</div>
	</div>
</section>

<style>
	.ehb { max-width: 1000px; margin: 0 auto; padding: 1.5rem 1rem 4rem; }
	.back { color: var(--accent); text-decoration: none; font-size: 0.9rem; }
	h1 { margin: 0.3rem 0 0.4rem; }
	.exp { font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.06em; color: var(--bg); background: var(--accent); padding: 0.1rem 0.4rem; border-radius: var(--radius); vertical-align: middle; text-shadow: none; }
	.muted { color: var(--muted); }
	.small { font-size: 0.85rem; }
	.card {
		background: linear-gradient(180deg, rgba(58, 48, 36, 0.85), rgba(40, 32, 24, 0.85));
		border: 1px solid var(--border);
		border-radius: var(--radius);
		box-shadow: var(--shadow-card);
		padding: 1.1rem 1.2rem;
		margin-top: 1.1rem;
	}
	.card > summary { cursor: pointer; }
	h2 { margin: 0 0 0.6rem; font-size: 1.1rem; color: var(--accent); text-shadow: var(--ts); }
	.assumptions { display: grid; grid-template-columns: repeat(auto-fill, minmax(12rem, 1fr)); gap: 0.6rem; margin-top: 0.8rem; }
	.assumptions label, .controls label { display: flex; flex-direction: column; gap: 0.2rem; font-size: 0.8rem; color: var(--muted); }
	.grid { display: grid; gap: 1.1rem; grid-template-columns: 1fr; }
	@media (min-width: 62rem) { .grid { grid-template-columns: 1fr 1fr; align-items: start; } }
	.card > input[type='text'] { width: 100%; }
	.controls { display: flex; gap: 0.6rem; }
	.controls label { flex: 1; }
	table { width: 100%; border-collapse: collapse; margin-top: 0.6rem; font-size: 0.82rem; }
	th { text-align: left; color: var(--accent); font-weight: normal; font-family: var(--font-heading); border-bottom: 1px solid var(--border); padding: 0.3rem 0.4rem; }
	td { padding: 0.3rem 0.4rem; border-bottom: 1px solid var(--surface-alt); vertical-align: top; }
	td.ehb { color: var(--accent); font-family: var(--font-heading); white-space: nowrap; }
	a { color: var(--accent); }
</style>
