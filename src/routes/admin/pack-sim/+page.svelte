<script lang="ts">
	import type { PageData, ActionData } from './$types';
	import { enhance } from '$app/forms';
	import { untrack } from 'svelte';
	import CardsTabs from '$lib/admin/CardsTabs.svelte';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	// untrack: the pack list is stable for the page's life; just seed the default.
	let packId = $state(untrack(() => data.packs[0]?.id ?? ''));
	let count = $state(1000);
	let trials = $state(100);
	let running = $state(false);

	let selectedPack = $derived(data.packs.find((p) => p.id === packId) ?? null);
	let busy = $derived(running || !selectedPack || selectedPack.card_count === 0);

	// SVG geometry for the completion curve (CDF) from the trial results.
	const CW = 600;
	const CH = 240;
	const PAD = { l: 46, r: 14, t: 12, b: 28 };
	let chart = $derived.by(() => {
		if (!form?.ok || !form.cdf || form.cdf.length < 2) return null;
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
			{ x: sx(form.medPacks), label: 'p50', val: form.medPacks },
			{ x: sx(form.p90Packs), label: 'p90', val: form.p90Packs }
		].filter((m) => m.val > 0 && m.val <= maxX);
		return { line, area, yTicks, xTicks, markers, px0, px1, py0, py1 };
	});

	const QUICK = [100, 1000, 10000, 50000];

	function fmt(n: number): string {
		return n.toLocaleString();
	}
</script>

<svelte:head>
	<title>Admin · Pack Simulator</title>
</svelte:head>

<section>
	<CardsTabs />
	<p class="muted">
		Open a pack thousands of times to check drop rates — uses the exact same roll
		as the real store. No VP is spent and nothing is saved.
	</p>

	{#if form && !form.ok && form.error}
		<div class="error">{form.error}</div>
	{/if}

	<form
		method="POST"
		action="?/simulate"
		use:enhance={() => {
			running = true;
			// reset: false keeps the pack + count inputs as you left them after a run.
			return async ({ update }) => {
				await update({ reset: false });
				running = false;
			};
		}}
	>
		<div class="controls">
			<label>
				<span>Pack</span>
				<select name="pack_id" bind:value={packId} required>
					{#each data.packs as p}
						<option value={p.id} disabled={p.card_count === 0}>
							{p.name} ({p.card_count} card{p.card_count === 1 ? '' : 's'} · {p.cards_per_pack}/open)
						</option>
					{/each}
				</select>
			</label>
			<label>
				<span>Packs to open</span>
				<input name="count" type="number" min="1" max={data.maxPacks} bind:value={count} />
			</label>
			<button type="submit" name="goal" value="count" class="primary" disabled={busy}>
				{running ? 'Opening…' : 'Open'}
			</button>
		</div>
		<div class="quick">
			{#each QUICK as q}
				<button type="button" class="chip" class:on={count === q} onclick={() => (count = q)}>{fmt(q)}</button>
			{/each}
			<span class="muted small">max {fmt(data.maxPacks)}</span>
		</div>
		<div class="goals">
			<label class="trials">
				<span>Trials</span>
				<input name="trials" type="number" min="1" max="10000" bind:value={trials} />
			</label>
			<button type="submit" name="goal" value="cards" class="ghost" disabled={busy}>
				Open until all cards
			</button>
			<button type="submit" name="goal" value="variations" class="ghost" disabled={busy}>
				Open until all variations
			</button>
			<span class="muted small">averaged over the trials</span>
		</div>
	</form>

	{#if form?.ok}
		<div class="results">
			{#if form.goal === 'cards' || form.goal === 'variations'}
				{@const targetN = form.goal === 'cards' ? form.targetCards : form.targetVariations}
				{@const noun = form.goal === 'cards' ? 'cards' : 'variations'}
				<h2>
					avg {fmt(Math.round(form.avgPacks))} packs to open all {fmt(targetN)} {noun}
					<span class="muted">— over {fmt(form.completedTrials)} trial{form.completedTrials === 1 ? '' : 's'}</span>
				</h2>
				{#if form.completedTrials > 0}
					<p class="stats muted">
						min {fmt(form.minPacks)} · median {fmt(form.medPacks)} · max {fmt(form.maxPacks)} · {fmt(form.packs)} packs opened total
					</p>
				{/if}
				{#if form.truncated}
					<div class="warn">
						Stopped at the safety cap — {fmt(form.completedTrials)} of {fmt(form.trials)} trials finished.
						Lower the trial count, or some variation is extremely rare with this pack's odds.
					</div>
				{/if}
				{#if chart}
					<div class="chart-wrap">
						<div class="chart-title muted small">Completion curve — % of trials done by N packs</div>
						<svg viewBox="0 0 {CW} {CH}" class="chart" role="img" aria-label="Completion curve">
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
			{:else}
				<h2>
					{fmt(form.packs)} × {form.packName}
					<span class="muted">— {fmt(form.totalCards)} cards ({form.cardsPerPack}/pack)</span>
				</h2>
			{/if}

			<div class="cols">
				<div class="panel">
					<h3>By rarity</h3>
					<ul class="bars">
						{#each form.rarities as r (r.key)}
							<li>
								<span class="rk" style="--rc: {r.color}">{r.label}</span>
								<div class="bar"><div class="fill" style="width: {r.pct}%; background: {r.color}"></div></div>
								<span class="num">{r.pct.toFixed(2)}%</span>
								<span class="cnt muted">{fmt(r.count)}</span>
							</li>
						{/each}
					</ul>
				</div>

				<div class="panel">
					<h3>By finish</h3>
					<ul class="bars">
						{#each form.finishes as f (f.key)}
							<li>
								<span class="rk">{f.label}</span>
								<div class="bar"><div class="fill" style="width: {f.pct}%"></div></div>
								<span class="num">{f.pct.toFixed(2)}%</span>
								<span class="cnt muted">{fmt(f.count)}</span>
							</li>
						{/each}
					</ul>
					<p class="muted small">
						Holo = last card per pack, Reverse = second-to-last (full-art cards stay Normal).
					</p>
				</div>
			</div>

			<h3>Per card ({form.cards.length})</h3>
			<table>
				<thead>
					<tr>
						<th>Card</th>
						<th>Rarity</th>
						<th class="r">Pulled</th>
						<th class="r">% of cards</th>
						<th class="r">Avg / pack</th>
						<th class="r">Normal</th>
						<th class="r">Holo</th>
						<th class="r">Reverse</th>
					</tr>
				</thead>
				<tbody>
					{#each form.cards as c (c.name + c.rarity)}
						<tr>
							<td>{c.name}{#if c.full_art} <span class="tag">full art</span>{/if}</td>
							<td><span class="rk" style="--rc: {c.color}">{c.label}</span></td>
							<td class="r">{fmt(c.count)}</td>
							<td class="r">{c.pct.toFixed(2)}%</td>
							<td class="r">{c.perPack.toFixed(3)}</td>
							<td class="r">{fmt(c.normal)}</td>
							<td class="r">{c.holo ? fmt(c.holo) : '—'}</td>
							<td class="r">{c.reverse ? fmt(c.reverse) : '—'}</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	{/if}
</section>

<style>
	.muted {
		color: var(--muted);
	}

	.small {
		font-size: 0.8rem;
	}

	.error {
		background: var(--danger-bg);
		border: 1px solid var(--danger);
		color: var(--danger);
		padding: 0.6rem 0.8rem;
		border-radius: 4px;
		margin: 1rem 0;
	}

	form {
		margin: 1.25rem 0 0.5rem;
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

	label span {
		font-size: 0.8rem;
		color: var(--muted);
	}

	.controls > label:first-child {
		flex: 1 1 16rem;
	}

	.controls input[type='number'] {
		width: 9rem;
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
	}

	.chip {
		min-height: auto;
		padding: 0.2rem 0.6rem;
		font-size: 0.8rem;
		background: var(--surface-alt);
		border: 1px solid var(--border);
		border-radius: 3px;
		color: var(--muted);
		cursor: pointer;
	}

	.chip.on {
		border-color: var(--accent);
		color: var(--accent);
	}

	.goals {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.5rem;
		margin-top: 0.75rem;
	}

	.ghost {
		min-height: auto;
		padding: 0.4rem 0.8rem;
		font-size: 0.85rem;
		background: var(--surface-alt);
		border: 1px solid var(--border);
		border-radius: var(--radius);
		color: var(--text);
		cursor: pointer;
	}

	.ghost:hover:not(:disabled) {
		border-color: var(--accent);
		color: var(--accent);
	}

	.ghost:disabled {
		opacity: 0.6;
		cursor: default;
	}

	.trials {
		flex-direction: row;
		align-items: center;
		gap: 0.4rem;
	}

	.trials span {
		font-size: 0.8rem;
		color: var(--muted);
	}

	.trials input {
		width: 5rem;
	}

	.stats {
		margin: -0.5rem 0 1rem;
		font-size: 0.85rem;
		font-variant-numeric: tabular-nums;
	}

	.chart-wrap {
		margin: 0.25rem 0 1.75rem;
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

	.warn {
		margin: 0 0 1rem;
		padding: 0.6rem 0.8rem;
		background: rgba(255, 152, 31, 0.12);
		border: 1px solid var(--accent);
		border-radius: 4px;
		font-size: 0.85rem;
		color: var(--text);
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

	.cols {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(18rem, 1fr));
		gap: 1.25rem;
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

	.bars {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 0.45rem;
	}

	.bars li {
		display: grid;
		grid-template-columns: 5.5rem 1fr 4rem 4rem;
		align-items: center;
		gap: 0.5rem;
	}

	.rk {
		color: var(--rc, var(--text));
		font-size: 0.85rem;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.bar {
		height: 0.6rem;
		background: rgba(0, 0, 0, 0.35);
		border-radius: 999px;
		overflow: hidden;
	}

	.fill {
		height: 100%;
		background: var(--accent);
		border-radius: 999px;
	}

	.num {
		text-align: right;
		font-variant-numeric: tabular-nums;
		font-size: 0.85rem;
	}

	.cnt {
		text-align: right;
		font-variant-numeric: tabular-nums;
		font-size: 0.8rem;
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

	.tag {
		padding: 0.02rem 0.35rem;
		border: 1px solid var(--border);
		border-radius: 3px;
		font-size: 0.65rem;
		color: var(--muted);
	}
</style>
