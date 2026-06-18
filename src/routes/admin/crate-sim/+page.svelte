<script lang="ts">
	import type { PageData, ActionData } from './$types';
	import { enhance } from '$app/forms';
	import { formatGP } from '$lib/gp';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	let mode = $state<'count' | 'budget'>('count');
	let count = $state(10000);
	let budget = $state(10000);
	let reinvest = $state(false);
	let trials = $state(200);
	let running = $state(false);

	const COUNT_QUICK = [1000, 10000, 100000, 1000000];
	const BUDGET_QUICK = [1000, 10000, 100000, 1000000];

	function fmt(n: number): string {
		return Math.round(n).toLocaleString();
	}
	function pct(n: number): string {
		return (n * 100).toFixed(1) + '%';
	}
	// Compact GP that keeps small values readable (formatGP floors sub-1K to a bare number).
	function gp(n: number): string {
		return formatGP(Math.round(n));
	}

	// Note when an enabled crate item has no known GP value (ITEM_PRICES miss) — its
	// drops won't contribute to the GP totals.
	const missingGp = $derived(data.items.filter((i) => i.gp <= 0).map((i) => i.name));

	// CDF chart geometry (budget mode) — mirrors the pack simulator.
	const CW = 600;
	const CH = 220;
	const PAD = { l: 46, r: 14, t: 12, b: 28 };
	let chart = $derived.by(() => {
		if (!form?.ok || form.mode !== 'budget' || !form.cdf || form.cdf.length < 2) return null;
		const px0 = PAD.l;
		const px1 = CW - PAD.r;
		const py0 = PAD.t;
		const py1 = CH - PAD.b;
		const maxX = Math.max(1, form.cdf[form.cdf.length - 1].x);
		const sx = (x: number) => px0 + (x / maxX) * (px1 - px0);
		const sy = (p: number) => py1 - (p / 100) * (py1 - py0);
		const pts = form.cdf.map((d) => `${sx(d.x).toFixed(1)},${sy(d.pct).toFixed(1)}`);
		const line = 'M' + pts.join(' L');
		const area = `M${sx(0).toFixed(1)},${py1.toFixed(1)} L${pts.join(' L')} L${sx(maxX).toFixed(1)},${py1.toFixed(1)} Z`;
		const yTicks = [0, 25, 50, 75, 100].map((p) => ({ y: sy(p), label: `${p}%` }));
		const xTicks = [0, 0.25, 0.5, 0.75, 1].map((f) => {
			const x = Math.round(maxX * f);
			return { x: sx(x), label: fmt(x) };
		});
		const markers = [
			{ x: sx(form.medSustained), label: 'p50', val: form.medSustained }
		].filter((m) => m.val > 0 && m.val <= maxX);
		return { line, area, yTicks, xTicks, markers, px0, px1, py0, py1 };
	});

	let busy = $derived(running);
</script>

<svelte:head>
	<title>Admin · Crate Simulator</title>
</svelte:head>

<nav class="crumbs"><a href="/admin">← Admin</a></nav>

<section>
	<h1>Crate Simulator</h1>
	<p class="muted">
		Open the gamba loot crate thousands of times to see what comes out — uses the exact same
		roll + odds as the real <a href="/gamba?tab=crates">store crate</a> (read live from
		<code>bot_config</code>). No VP is spent and nothing is saved. GP values come from the
		wallet price list (<code>ITEM_PRICES</code>).
	</p>

	<div class="cfg muted small">
		Crate cost <strong>{fmt(data.cost)} VP</strong>
		· {data.tiers.length} VP tiers
		· {data.items.length} item{data.items.length === 1 ? '' : 's'}
		{#if data.roleLabel}· role: {data.roleLabel}{/if}
	</div>
	{#if missingGp.length}
		<div class="warn small">
			No GP value set for: {missingGp.join(', ')} — these drops won't count toward GP totals.
			Add them to <code>ITEM_PRICES</code> in <code>src/lib/gp.ts</code>.
		</div>
	{/if}

	{#if form && !form.ok && form.error}
		<div class="error">{form.error}</div>
	{/if}

	<form
		method="POST"
		action="?/simulate"
		use:enhance={() => {
			running = true;
			return async ({ update }) => {
				await update({ reset: false });
				running = false;
			};
		}}
	>
		<input type="hidden" name="mode" value={mode} />
		<input type="hidden" name="reinvest" value={reinvest ? '1' : '0'} />

		<div class="modes">
			<button type="button" class="seg" class:on={mode === 'count'} onclick={() => (mode = 'count')}>
				Open N crates
			</button>
			<button type="button" class="seg" class:on={mode === 'budget'} onclick={() => (mode = 'budget')}>
				Spend a VP budget
			</button>
		</div>

		{#if mode === 'count'}
			<div class="controls">
				<label>
					<span>Crates to open</span>
					<input name="count" type="number" min="1" max={data.maxCount} bind:value={count} />
				</label>
				<button type="submit" class="primary" disabled={busy}>{running ? 'Opening…' : 'Simulate'}</button>
			</div>
			<div class="quick">
				{#each COUNT_QUICK as q}
					<button type="button" class="chip" class:on={count === q} onclick={() => (count = q)}>{fmt(q)}</button>
				{/each}
				<span class="muted small">max {fmt(data.maxCount)}</span>
			</div>
		{:else}
			<div class="controls">
				<label>
					<span>VP budget</span>
					<input name="budget" type="number" min={data.cost} max={data.maxBudget} bind:value={budget} />
				</label>
				<label class="trials">
					<span>Trials</span>
					<input name="trials" type="number" min="1" max={data.maxTrials} bind:value={trials} />
				</label>
				<button type="submit" class="primary" disabled={busy}>{running ? 'Spinning…' : 'Simulate'}</button>
			</div>
			<div class="quick">
				{#each BUDGET_QUICK as q}
					<button type="button" class="chip" class:on={budget === q} onclick={() => (budget = q)}>{fmt(q)}</button>
				{/each}
				<span class="muted small">max {fmt(data.maxBudget)} VP</span>
			</div>
			<label class="reinvest">
				<input type="checkbox" bind:checked={reinvest} />
				<span>Auto-reinvest VP won — feed VP rewards back into the budget and keep opening until it runs dry</span>
			</label>
		{/if}
	</form>

	{#if form?.ok}
		<div class="results">
			{#if form.mode === 'count'}
				<h2>{fmt(form.crates)} crates opened <span class="muted">· {fmt(form.cost)} VP each</span></h2>
			{:else}
				<h2>
					{fmt(form.budget)} VP budget{form.reinvest ? ' · reinvesting' : ''}
					<span class="muted">· over {fmt(form.trials)} trial{form.trials === 1 ? '' : 's'} · {fmt(form.crates)} crates total</span>
				</h2>
			{/if}

			{#if form.truncated}
				<div class="warn">
					Stopped at the safety cap before some trials depleted — results are a lower bound. Lower the
					budget or trial count. (Reinvesting with a near-break-even table can run extremely long.)
				</div>
			{/if}

			<!-- Headline economy metrics -->
			<div class="cards">
				<div class="stat">
					<span class="lbl">VP spent</span>
					<strong>{fmt(form.vpSpent)}</strong>
				</div>
				<div class="stat">
					<span class="lbl">VP won</span>
					<strong>{fmt(form.vpWon)}</strong>
				</div>
				<div class="stat">
					<span class="lbl">Net VP</span>
					<strong class={form.netVp < 0 ? 'neg' : 'pos'}>{form.netVp >= 0 ? '+' : ''}{fmt(form.netVp)}</strong>
				</div>
				<div class="stat hl">
					<span class="lbl">VP returned</span>
					<strong>{pct(form.returnRatio)}</strong>
					<span class="sub muted">per VP spent</span>
				</div>
				<div class="stat">
					<span class="lbl">GP generated</span>
					<strong>{gp(form.gpWon)}</strong>
				</div>
				<div class="stat hl">
					<span class="lbl">GP per VP spent</span>
					<strong>{gp(form.gpPerVpSpent)}</strong>
				</div>
				<div class="stat">
					<span class="lbl">GP per crate</span>
					<strong>{gp(form.gpPerCrate)}</strong>
				</div>
				<div class="stat">
					<span class="lbl">Avg VP / crate</span>
					<strong>{form.avgVpPerCrate.toFixed(2)}</strong>
				</div>
				<div class="stat">
					<span class="lbl">Items</span>
					<strong>{fmt(form.itemCount)}</strong>
					<span class="sub muted">{pct(form.itemRate)} of crates</span>
				</div>
				<div class="stat">
					<span class="lbl">Junk (0 VP)</span>
					<strong>{fmt(form.nothing)}</strong>
				</div>
				<div class="stat">
					<span class="lbl">Role drops</span>
					<strong>{fmt(form.roleCount)}</strong>
				</div>
				<div class="stat">
					<span class="lbl">Biggest VP</span>
					<strong>{fmt(form.maxVp)}</strong>
				</div>
			</div>

			{#if form.mode === 'budget'}
				<h3>How far the budget stretched</h3>
				<div class="cards">
					<div class="stat hl">
						<span class="lbl">Avg crates / budget</span>
						<strong>{fmt(form.avgSustained)}</strong>
						{#if form.reinvest}<span class="sub muted">vs {fmt(form.budget / form.cost)} without reinvest</span>{/if}
					</div>
					<div class="stat">
						<span class="lbl">Crates range</span>
						<strong>{fmt(form.minSustained)} – {fmt(form.maxSustained)}</strong>
						<span class="sub muted">median {fmt(form.medSustained)}</span>
					</div>
					<div class="stat">
						<span class="lbl">Avg leftover</span>
						<strong>{fmt(form.avgLeftover)} VP</strong>
					</div>
					{#if form.reinvest}
						<div class="stat hl">
							<span class="lbl">GP per net VP</span>
							<strong>{gp(form.gpPerNetVp)}</strong>
							<span class="sub muted">{fmt(form.netVpConsumed / form.trials)} net VP / budget</span>
						</div>
						<div class="stat">
							<span class="lbl">Crates per VP budgeted</span>
							<strong>{form.cratesPerVpBudgeted.toFixed(3)}</strong>
						</div>
					{/if}
				</div>

				{#if chart}
					<div class="chart-wrap">
						<div class="chart-title muted small">Survival curve — % of budgets depleted by N crates</div>
						<svg viewBox="0 0 {CW} {CH}" class="chart" role="img" aria-label="Crates-sustained distribution">
							{#each chart.yTicks as yt}
								<line class="grid" x1={chart.px0} y1={yt.y} x2={chart.px1} y2={yt.y} />
								<text class="ylab" x={chart.px0 - 6} y={yt.y}>{yt.label}</text>
							{/each}
							<path class="area" d={chart.area} />
							<path class="line" d={chart.line} />
							{#each chart.markers as m}
								<line class="marker" x1={m.x} y1={chart.py0} x2={m.x} y2={chart.py1} />
								<text class="mlab" x={m.x} y={chart.py0 + 10}>{m.label}</text>
							{/each}
							{#each chart.xTicks as xt}
								<text class="xlab" x={xt.x} y={chart.py1 + 16}>{xt.label}</text>
							{/each}
						</svg>
					</div>
				{/if}
			{/if}

			<div class="cols">
				<div class="panel">
					<h3>By VP tier</h3>
					<table>
						<thead>
							<tr><th>Tier</th><th class="r">Count</th><th class="r">%</th><th class="r">Total VP</th></tr>
						</thead>
						<tbody>
							{#each form.tierRows as r (r.label)}
								<tr>
									<td><span class="rk" style="--rc: {r.color ?? 'var(--text)'}">{r.label}</span></td>
									<td class="r">{fmt(r.count)}</td>
									<td class="r">{r.pct.toFixed(2)}%</td>
									<td class="r">{fmt(r.vp)}</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>

				<div class="panel">
					<h3>By item</h3>
					{#if form.itemRows.length}
						<table>
							<thead>
								<tr><th>Item</th><th class="r">Count</th><th class="r">%</th><th class="r">Each</th><th class="r">Total GP</th></tr>
							</thead>
							<tbody>
								{#each form.itemRows as r (r.name)}
									<tr>
										<td>{r.name}</td>
										<td class="r">{fmt(r.count)}</td>
										<td class="r">{r.pct.toFixed(3)}%</td>
										<td class="r">{r.eachGp ? gp(r.eachGp) : '—'}</td>
										<td class="r">{r.gp ? gp(r.gp) : '—'}</td>
									</tr>
								{/each}
							</tbody>
						</table>
					{:else}
						<p class="muted small">No item drops this run.</p>
					{/if}
				</div>
			</div>
		</div>
	{/if}
</section>

<style>
	.crumbs {
		margin-bottom: 0.75rem;
	}
	.crumbs a {
		color: rgba(255, 255, 255, 0.5);
		font-size: 0.95rem;
		text-decoration: none;
	}
	.crumbs a:hover {
		color: var(--accent);
	}

	h1 {
		margin-bottom: 0.25rem;
	}

	.muted {
		color: var(--muted);
	}
	.small {
		font-size: 0.8rem;
	}

	p {
		max-width: 52rem;
	}

	code {
		font-size: 0.85em;
		background: var(--surface-alt);
		padding: 0.05rem 0.3rem;
		border-radius: 3px;
	}

	.cfg {
		margin-top: 0.5rem;
	}

	.error {
		background: var(--danger-bg);
		border: 1px solid var(--danger);
		color: var(--danger);
		padding: 0.6rem 0.8rem;
		border-radius: 4px;
		margin: 1rem 0;
	}

	.warn {
		margin: 0.6rem 0;
		padding: 0.6rem 0.8rem;
		background: rgba(255, 152, 31, 0.12);
		border: 1px solid var(--accent);
		border-radius: 4px;
		font-size: 0.85rem;
		color: var(--text);
		max-width: 52rem;
	}

	form {
		margin: 1.25rem 0 0.5rem;
	}

	.modes {
		display: flex;
		gap: 0.4rem;
		margin-bottom: 1rem;
	}

	.seg {
		min-height: auto;
		padding: 0.45rem 0.9rem;
		font-size: 0.9rem;
		background: var(--surface-alt);
		border: 1px solid var(--border);
		border-radius: var(--radius);
		color: var(--muted);
		cursor: pointer;
	}
	.seg.on {
		border-color: var(--accent);
		color: var(--accent);
		background: var(--accent-soft);
	}

	.controls {
		display: flex;
		flex-wrap: wrap;
		align-items: flex-end;
		gap: 0.75rem;
	}

	label {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
	}
	label > span {
		font-size: 0.8rem;
		color: var(--muted);
	}

	.controls input[type='number'] {
		width: 11rem;
	}

	.trials {
		flex-direction: column;
	}
	.trials input {
		width: 6rem;
	}

	button.primary {
		border-color: var(--accent);
		font-family: 'rsbold', ui-sans-serif, Arial, sans-serif;
	}
	button.primary:hover:not(:disabled) {
		background: var(--accent-soft);
	}
	button.primary:disabled {
		opacity: 0.6;
		cursor: default;
	}

	.quick {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		margin-top: 0.6rem;
		flex-wrap: wrap;
	}

	.chip {
		min-height: auto;
		padding: 0.2rem 0.6rem;
		font-size: 0.8rem;
		background: var(--surface-alt);
		border: 1px solid var(--border);
		border-radius: 999px;
		color: var(--muted);
		cursor: pointer;
	}
	.chip.on {
		border-color: var(--accent);
		color: var(--accent);
	}

	.reinvest {
		flex-direction: row;
		align-items: flex-start;
		gap: 0.5rem;
		margin-top: 0.9rem;
		max-width: 40rem;
		cursor: pointer;
	}
	.reinvest span {
		font-size: 0.85rem;
		color: var(--text);
	}
	.reinvest input {
		margin-top: 0.15rem;
	}

	.results {
		margin-top: 2rem;
	}

	h2 {
		margin: 0 0 1rem;
		font-size: 1.2rem;
	}
	h3 {
		margin: 1.5rem 0 0.75rem;
		font-size: 1rem;
	}

	.cards {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(9.5rem, 1fr));
		gap: 0.75rem;
	}

	.stat {
		display: flex;
		flex-direction: column;
		gap: 0.15rem;
		padding: 0.7rem 0.85rem;
		background: var(--surface-alt);
		border: 1px solid var(--border);
		border-radius: var(--radius);
	}
	.stat.hl {
		border-color: var(--accent);
		background: var(--accent-soft);
	}
	.stat .lbl {
		font-size: 0.72rem;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		color: var(--muted);
	}
	.stat strong {
		font-size: 1.25rem;
		font-variant-numeric: tabular-nums;
		font-family: 'rsbold', ui-sans-serif, Arial, sans-serif;
	}
	.stat .sub {
		font-size: 0.72rem;
	}
	.stat strong.neg {
		color: var(--danger);
	}
	.stat strong.pos {
		color: var(--accent);
	}

	.chart-wrap {
		margin: 1rem 0 1.75rem;
	}
	.chart-title {
		margin-bottom: 0.4rem;
	}
	.chart {
		width: 100%;
		height: auto;
		display: block;
		background: var(--surface-alt);
		border: 1px solid var(--border);
		border-radius: var(--radius);
	}
	.chart .grid {
		stroke: rgba(255, 255, 255, 0.08);
		stroke-width: 1;
	}
	.chart .area {
		fill: var(--accent);
		opacity: 0.16;
	}
	.chart .line {
		fill: none;
		stroke: var(--accent);
		stroke-width: 2;
	}
	.chart .marker {
		stroke: var(--muted);
		stroke-width: 1;
		stroke-dasharray: 3 3;
		opacity: 0.7;
	}
	.chart .ylab {
		fill: var(--muted);
		font-size: 11px;
		text-anchor: end;
		dominant-baseline: middle;
	}
	.chart .xlab {
		fill: var(--muted);
		font-size: 11px;
		text-anchor: middle;
	}
	.chart .mlab {
		fill: var(--muted);
		font-size: 10px;
		text-anchor: middle;
	}

	.cols {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(20rem, 1fr));
		gap: 1.25rem;
		margin-top: 0.5rem;
	}

	.panel {
		padding: 1rem 1.1rem;
		background: var(--surface-alt);
		border: 1px solid var(--border);
		border-radius: var(--radius);
	}
	.panel h3 {
		margin: 0 0 0.75rem;
	}

	table {
		width: 100%;
		border-collapse: collapse;
		font-size: 0.9rem;
	}
	th,
	td {
		padding: 0.4rem 0.6rem;
		border-bottom: 1px solid var(--border);
		text-align: left;
	}
	th.r,
	td.r {
		text-align: right;
		font-variant-numeric: tabular-nums;
	}
	thead th {
		color: var(--muted);
		font-weight: normal;
		font-size: 0.8rem;
	}

	.rk {
		color: var(--rc, var(--text));
		font-size: 0.85rem;
	}
</style>
