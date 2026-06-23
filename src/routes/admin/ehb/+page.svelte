<script lang="ts">
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	// ── Item lookup ──────────────────────────────────────────────────────────
	let query = $state('');
	const lookup = $derived.by(() => {
		const q = query.trim().toLowerCase();
		if (q.length < 2) return [];
		return data.items
			.filter((i) => i.name.toLowerCase().includes(q))
			.slice(0, 50);
	});

	// ── EHB target filter ──────────────────────────────────────────────────────
	let target = $state(5);
	let tolerance = $state(1);
	const matches = $derived.by(() => {
		const lo = target - tolerance;
		const hi = target + tolerance;
		return data.items
			.filter((i) => i.ehbPerItem >= lo && i.ehbPerItem <= hi)
			.sort((a, b) => Math.abs(a.ehbPerItem - target) - Math.abs(b.ehbPerItem - target))
			.slice(0, 100);
	});

	function fmtHours(h: number): string {
		if (h < 1) return `${Math.round(h * 60)} min`;
		return `${h.toFixed(2)} h`;
	}
</script>

<svelte:head><title>EHB Drop Tool · Admin</title></svelte:head>

<section class="ehb">
	<a class="back" href="/admin/events">← Events</a>
	<h1>EHB Drop Tool <span class="exp">experimental</span></h1>
	<p class="muted">
		<strong>EHB per item</strong> = expected kills to get the drop ÷ the boss's
		<a href="https://wiseoldman.net/ehb/iron" target="_blank" rel="noreferrer">WiseOldMan <strong>ironman</strong> EHB rate</a>
		(kills/hr) — i.e. expected efficient bossing hours to obtain it. Drop rates from
		<a href="https://github.com/pairofcrocs/drop-rates-clog" target="_blank" rel="noreferrer">drop-rates-clog</a>,
		item names from the RuneLite cache. Covers {data.items.length} boss/raid-droppable items
		(cheapest source per item). Clue/skilling-only drops are excluded (no EHB rate).
	</p>
	<p class="muted small">
		⚠ Raid uniques (CoX/ToB) list a share of the <em>purple</em> table, so EHB also factors an
		assumed per-raid purple rate (CoX ≈ 1/28.7, ToB ≈ 1/9.1) — points/invocation-dependent, so
		treat raid numbers as approximate.
	</p>

	<div class="grid">
		<!-- Lookup -->
		<div class="card">
			<h2>Item lookup</h2>
			<input type="text" placeholder="Search item name…" bind:value={query} />
			{#if query.trim().length >= 2}
				{#if lookup.length === 0}
					<p class="muted small">No boss-droppable item matches “{query}”.</p>
				{:else}
					<table>
						<thead>
							<tr><th>Item</th><th>Drop rate</th><th>Source</th><th>EHB rate</th><th>EHB/item</th></tr>
						</thead>
						<tbody>
							{#each lookup as i (i.id)}
								<tr>
									<td>{i.name} <code>#{i.id}</code></td>
									<td>{i.dropRate}{#if i.approx} ~{/if}</td>
									<td>{i.source}</td>
									<td>{i.ehbRate}/h</td>
									<td class="ehb">{fmtHours(i.ehbPerItem)}</td>
								</tr>
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
				<label><span>Target EHB</span><input type="number" min="0" step="0.5" bind:value={target} /></label>
				<label><span>± tolerance</span><input type="number" min="0" step="0.5" bind:value={tolerance} /></label>
			</div>
			<p class="muted small">{matches.length} item{matches.length === 1 ? '' : 's'} within {fmtHours(Math.max(0, target - tolerance))}–{fmtHours(target + tolerance)}.</p>
			<table>
				<thead>
					<tr><th>Item</th><th>EHB/item</th><th>Drop rate</th><th>Source</th></tr>
				</thead>
				<tbody>
					{#each matches as i (i.id)}
						<tr>
							<td>{i.name}</td>
							<td class="ehb">{fmtHours(i.ehbPerItem)}</td>
							<td>{i.dropRate}{#if i.approx} ~{/if}</td>
							<td>{i.source}</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	</div>
</section>

<style>
	/* Reuses the site's global form-control styling (src/app.css) + design tokens. */
	.ehb { max-width: 1000px; margin: 0 auto; padding: 1.5rem 1rem 4rem; }
	.back { color: var(--accent); text-decoration: none; font-size: 0.9rem; }
	h1 { margin: 0.3rem 0 0.4rem; }
	.exp { font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.06em; color: var(--bg); background: var(--accent); padding: 0.1rem 0.4rem; border-radius: var(--radius); vertical-align: middle; text-shadow: none; }
	.muted { color: var(--muted); }
	.small { font-size: 0.85rem; }
	.grid { display: grid; gap: 1.1rem; margin-top: 1rem; grid-template-columns: 1fr; }
	@media (min-width: 60rem) { .grid { grid-template-columns: 1fr 1fr; align-items: start; } }
	.card {
		background: linear-gradient(180deg, rgba(58, 48, 36, 0.85), rgba(40, 32, 24, 0.85));
		border: 1px solid var(--border);
		border-radius: var(--radius);
		box-shadow: var(--shadow-card);
		padding: 1.1rem 1.2rem;
	}
	h2 { margin: 0 0 0.6rem; font-size: 1.1rem; color: var(--accent); text-shadow: var(--ts); }
	.card > input[type='text'] { width: 100%; }
	.controls { display: flex; gap: 0.6rem; }
	.controls label { display: flex; flex-direction: column; gap: 0.2rem; font-size: 0.8rem; color: var(--muted); flex: 1; }
	table { width: 100%; border-collapse: collapse; margin-top: 0.6rem; font-size: 0.82rem; }
	th { text-align: left; color: var(--accent); font-weight: normal; font-family: var(--font-heading); border-bottom: 1px solid var(--border); padding: 0.3rem 0.4rem; }
	td { padding: 0.3rem 0.4rem; border-bottom: 1px solid var(--surface-alt); vertical-align: top; }
	td.ehb { color: var(--accent); font-family: var(--font-heading); white-space: nowrap; }
	code { color: var(--muted); font-size: 0.75rem; }
	a { color: var(--accent); }
</style>
