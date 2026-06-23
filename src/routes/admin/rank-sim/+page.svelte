<script lang="ts">
	import type { PageData, ActionData } from './$types';
	import { enhance } from '$app/forms';
	import { rankColor } from '$lib/ranks';
	import ConfirmDialog from '$lib/ConfirmDialog.svelte';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	// Latest results/config come from a recalc/refresh response when present, else the load.
	let config = $derived(form && 'config' in form && form.config ? form.config : data.config);
	let summary = $derived(form && 'summary' in form && form.summary ? form.summary : data.summary);
	let cachedCount = $derived(
		form && 'cachedCount' in form && typeof form.cachedCount === 'number'
			? form.cachedCount
			: data.cachedCount
	);

	let refreshing = $state(false);
	let recalcing = $state(false);
	let applying = $state(false);
	let applyOpen = $state(false);
	let applyForm = $state<HTMLFormElement>();

	const weightKeys = [
		['w_gear', 'gear', 'Gear'],
		['w_ehb', 'ehb', 'EHB'],
		['w_ca', 'ca', 'Combat Achv'],
		['w_time', 'time', 'Time in clan'],
		['w_clog', 'clog', 'Collection log'],
		['w_level', 'level', 'Total level']
	] as const;

	const capKeys = [
		['c_ehb', 'ehb', 'EHB cap'],
		['c_months', 'months', 'Months cap'],
		['c_clog', 'clog', 'Clog slots cap'],
		['c_levelMin', 'levelMin', 'Level floor'],
		['c_levelRange', 'levelRange', 'Level range']
	] as const;

	let weightSum = $derived(
		Object.values(config.weights).reduce((s: number, n) => s + (n as number), 0)
	);
	function thr(role: string): number {
		return config.thresholds.find((t) => t.womRole === role)?.scoreMin ?? 0;
	}
	let maxBucket = $derived(Math.max(1, ...summary.histogram.map((b) => b.count)));
</script>

<svelte:head>
	<title>Rank Sim · Admin · Volition</title>
</svelte:head>

<section class="wrap">
	<h1>Rank Simulator</h1>
	<p class="muted">
		Re-score the whole clan from cached data as you tune the composite weights and thresholds,
		then save the config live or apply the projected ranks to <code>players.rank</code>.
	</p>

	<!-- Data refresh ------------------------------------------------------- -->
	<div class="card">
		<div class="row between">
			<div>
				<strong>Cached data</strong>
				<p class="muted small">
					{cachedCount} players cached{#if data.lastFetched}
						· last fetch {new Date(data.lastFetched).toLocaleString()}{/if}
				</p>
				{#if form && 'refreshOk' in form && form.refreshOk}
					<p class="ok small">
						Fetched {form.processed} player(s). {form.cachedCount}/{form.rosterSize} cached — click
						again to continue.
					</p>
				{:else if form && 'refreshError' in form && form.refreshError}
					<p class="err small">{form.refreshError}</p>
				{/if}
			</div>
			<form
				method="POST"
				action="?/refresh"
				use:enhance={() => {
					refreshing = true;
					return async ({ update }) => {
						await update({ reset: false });
						refreshing = false;
					};
				}}
			>
				<button class="btn" type="submit" disabled={refreshing}>
					{refreshing ? 'Fetching…' : 'Refresh next batch'}
				</button>
			</form>
		</div>
	</div>

	<!-- Tuning form -------------------------------------------------------- -->
	<form
		method="POST"
		action="?/recalc"
		use:enhance={() => {
			recalcing = true;
			return async ({ update }) => {
				await update({ reset: false });
				recalcing = false;
			};
		}}
	>
		<div class="card">
			<div class="row between">
				<strong>Weights</strong>
				<span class="muted small" class:warn={Math.abs(weightSum - 1) > 0.001}>
					sum {weightSum.toFixed(3)}{Math.abs(weightSum - 1) > 0.001 ? ' (≠ 1.0)' : ''}
				</span>
			</div>
			<div class="grid">
				{#each weightKeys as [name, key, label]}
					<label>
						<span>{label}</span>
						<input type="number" step="0.01" {name} value={config.weights[key]} />
					</label>
				{/each}
			</div>

			<strong class="mt">Normalization caps</strong>
			<div class="grid">
				{#each capKeys as [name, key, label]}
					<label>
						<span>{label}</span>
						<input type="number" step="1" {name} value={config.caps[key]} />
					</label>
				{/each}
			</div>

			<strong class="mt">Score → rank thresholds (composite floor)</strong>
			<div class="grid thresholds">
				{#each data.rankOrder as role}
					<label>
						<span style="color:{rankColor(role)}">{data.rankLabels[role]}</span>
						<input type="number" step="0.01" min="0" max="1" name={`t_${role}`} value={thr(role)} />
					</label>
				{/each}
			</div>

			<div class="row gap mt">
				<button class="btn primary" type="submit" disabled={recalcing}>
					{recalcing ? 'Recalculating…' : 'Recalculate'}
				</button>
				<button class="btn" type="submit" name="save" value="1" disabled={recalcing}>
					Save as live config & recalc
				</button>
				{#if form && 'saved' in form && form.saved}<span class="ok small">Saved live.</span>{/if}
				{#if form && 'saveError' in form && form.saveError}<span class="err small">{form.saveError}</span>{/if}
			</div>
		</div>
	</form>

	<!-- Distribution ------------------------------------------------------- -->
	<div class="card">
		<strong>Rank distribution ({summary.total} players)</strong>
		<table>
			<thead>
				<tr><th>Rank</th><th>Current</th><th>Projected</th><th>Δ</th></tr>
			</thead>
			<tbody>
				{#each summary.distribution as d}
					<tr>
						<td><span class="dot" style="background:{rankColor(d.rank)}"></span>{d.label}</td>
						<td>{d.current} <span class="muted">({d.currentPct.toFixed(1)}%)</span></td>
						<td>{d.projected} <span class="muted">({d.projectedPct.toFixed(1)}%)</span></td>
						<td class:up={d.diff > 0} class:down={d.diff < 0}>
							{d.diff > 0 ? '+' : ''}{d.diff}
						</td>
					</tr>
				{/each}
			</tbody>
		</table>
	</div>

	<!-- Component averages + histogram ------------------------------------ -->
	<div class="card">
		<strong>Component averages (0–1)</strong>
		<div class="avgs">
			<span>Gear {summary.componentAverages.gear.toFixed(3)}</span>
			<span>EHB {summary.componentAverages.ehb.toFixed(3)}</span>
			<span>CA {summary.componentAverages.ca.toFixed(3)}</span>
			<span>Time {summary.componentAverages.time.toFixed(3)}</span>
			<span>Clog {summary.componentAverages.clog.toFixed(3)}</span>
			<span>Level {summary.componentAverages.level.toFixed(3)}</span>
			<span class="strong">Composite {summary.componentAverages.composite.toFixed(3)}</span>
		</div>

		<strong class="mt">Composite histogram</strong>
		<div class="hist">
			{#each summary.histogram as b}
				<div class="hbar" title={`${b.lo.toFixed(2)}–${b.hi.toFixed(2)}: ${b.count}`}>
					<div class="fill" style="height:{(b.count / maxBucket) * 100}%"></div>
				</div>
			{/each}
		</div>
		<div class="muted small">0.00 → 1.00 composite, 20 buckets</div>
	</div>

	<!-- Notable changes ---------------------------------------------------- -->
	{#if summary.upgrades.length || summary.downgrades.length}
		<div class="card cols">
			<div>
				<strong>Top upgrades</strong>
				<ul class="changes">
					{#each summary.upgrades as c}
						<li>{c.rsn}: <span style="color:{rankColor(c.from)}">{c.from}</span> → <span style="color:{rankColor(c.to)}">{c.to}</span> (+{c.delta})</li>
					{:else}
						<li class="muted">None</li>
					{/each}
				</ul>
			</div>
			<div>
				<strong>Top downgrades</strong>
				<ul class="changes">
					{#each summary.downgrades as c}
						<li>{c.rsn}: <span style="color:{rankColor(c.from)}">{c.from}</span> → <span style="color:{rankColor(c.to)}">{c.to}</span> ({c.delta})</li>
					{:else}
						<li class="muted">None</li>
					{/each}
				</ul>
			</div>
		</div>
	{/if}

	<!-- Player table ------------------------------------------------------- -->
	<div class="card">
		<strong>Players ({summary.players.length})</strong>
		<div class="tablewrap">
			<table class="players">
				<thead>
					<tr>
						<th>RSN</th><th>Current</th><th>Projected</th><th>Score</th><th>EHB</th>
						<th>Gear</th><th>CA</th><th>Clog</th><th>Lvl</th><th>Mo</th><th>Src</th>
					</tr>
				</thead>
				<tbody>
					{#each summary.players as p}
						<tr>
							<td>{p.rsn}</td>
							<td>{#if p.current}<span style="color:{rankColor(p.current)}">{p.current}</span>{:else}<span class="muted">—</span>{/if}</td>
							<td><span style="color:{rankColor(p.projected)}">{p.projected}</span></td>
							<td>{p.composite.toFixed(4)}</td>
							<td>{p.ehb}</td>
							<td>{p.gearPoints}</td>
							<td>{p.caPoints}</td>
							<td>{p.clogFinished}</td>
							<td>{p.totalLevel ?? '—'}</td>
							<td>{p.months}</td>
							<td class="src">{p.templeAvailable ? 'T' : '·'}{p.wikisyncAvailable ? 'W' : '·'}</td>
						</tr>
					{:else}
						<tr><td colspan="11" class="muted">No cached players yet — refresh to fetch clan data.</td></tr>
					{/each}
				</tbody>
			</table>
		</div>
	</div>

	<!-- Apply -------------------------------------------------------------- -->
	<div class="card">
		<div class="row between">
			<div>
				<strong>Apply to live ranks</strong>
				<p class="muted small">Writes each player's projected rank (using the SAVED config) to players.rank.</p>
				{#if form && 'applyOk' in form && form.applyOk}
					<p class="ok small">Updated {form.updated} player(s); {form.missing} had no player row.</p>
				{/if}
			</div>
			<form
				bind:this={applyForm}
				method="POST"
				action="?/apply"
				use:enhance={() => {
					applying = true;
					return async ({ update }) => {
						await update({ reset: false });
						applying = false;
						applyOpen = false;
					};
				}}
			>
				<button class="btn danger" type="button" disabled={applying} onclick={() => (applyOpen = true)}>
					{applying ? 'Applying…' : 'Apply projected ranks'}
				</button>
			</form>
		</div>
	</div>
</section>

<ConfirmDialog
	bind:open={applyOpen}
	title="Apply projected ranks?"
	message={`This overwrites players.rank for all ${summary.total} cached players with their projected rank (using the SAVED live config). The bot will sync these to Discord roles. Make sure you've saved the config you want first.`}
	confirmLabel="Apply"
	busyLabel="Applying…"
	busy={applying}
	danger
	onconfirm={() => applyForm?.requestSubmit()}
/>

<style>
	.wrap {
		max-width: 1000px;
		margin: 0 auto;
	}
	h1 {
		margin-bottom: 0.25rem;
	}
	.muted {
		color: var(--muted);
	}
	.small {
		font-size: 0.82rem;
	}
	.ok {
		color: var(--success);
	}
	.err {
		color: var(--danger);
	}
	.warn {
		color: var(--danger);
	}
	code {
		font-size: 0.85em;
	}
	.card {
		background: var(--surface-alt);
		border: 1px solid var(--border);
		border-radius: var(--radius);
		padding: 1rem 1.1rem;
		margin-top: 1rem;
	}
	.row {
		display: flex;
		align-items: center;
		gap: 0.75rem;
	}
	.between {
		justify-content: space-between;
		flex-wrap: wrap;
	}
	.gap {
		flex-wrap: wrap;
		gap: 0.6rem;
	}
	.mt {
		display: block;
		margin-top: 1rem;
	}
	.grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(8rem, 1fr));
		gap: 0.6rem;
		margin-top: 0.5rem;
	}
	.thresholds {
		grid-template-columns: repeat(auto-fill, minmax(6.5rem, 1fr));
	}
	label {
		display: flex;
		flex-direction: column;
		gap: 0.2rem;
	}
	label span {
		font-size: 0.78rem;
		color: var(--muted);
	}
	input {
		width: 100%;
	}
	.btn {
		border: 1px solid var(--border);
		background: var(--surface);
		color: var(--text);
		padding: 0.5rem 0.9rem;
		border-radius: var(--radius);
		cursor: pointer;
	}
	.btn:hover:not(:disabled) {
		border-color: var(--accent);
	}
	.btn:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}
	.btn.primary {
		border-color: var(--accent);
		color: var(--accent);
		background: var(--accent-soft);
		font-family: 'rsbold', ui-sans-serif, Arial, sans-serif;
	}
	.btn.danger {
		border-color: var(--danger);
		color: var(--danger);
	}
	table {
		width: 100%;
		border-collapse: collapse;
		margin-top: 0.6rem;
		font-size: 0.88rem;
	}
	th,
	td {
		text-align: left;
		padding: 0.35rem 0.5rem;
		border-bottom: 1px solid var(--border);
	}
	td.up {
		color: var(--success);
	}
	td.down {
		color: var(--danger);
	}
	.dot {
		display: inline-block;
		width: 0.7rem;
		height: 0.7rem;
		border-radius: 999px;
		margin-right: 0.4rem;
		vertical-align: middle;
	}
	.avgs {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
		margin-top: 0.5rem;
	}
	.avgs span {
		padding: 0.25rem 0.55rem;
		background: var(--surface);
		border: 1px solid var(--border);
		border-radius: 3px;
		font-size: 0.82rem;
	}
	.avgs .strong {
		border-color: var(--accent);
		color: var(--accent);
	}
	.hist {
		display: flex;
		align-items: flex-end;
		gap: 2px;
		height: 90px;
		margin-top: 0.6rem;
	}
	.hbar {
		flex: 1;
		display: flex;
		align-items: flex-end;
		background: var(--surface);
		border-radius: 2px;
	}
	.hbar .fill {
		width: 100%;
		background: var(--accent);
		border-radius: 2px;
		min-height: 1px;
	}
	.cols {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 1.5rem;
	}
	.changes {
		margin: 0.4rem 0 0;
		padding-left: 1rem;
		font-size: 0.85rem;
		line-height: 1.5;
	}
	.tablewrap {
		overflow-x: auto;
	}
	.players td.src {
		font-family: ui-monospace, monospace;
		color: var(--muted);
	}
	@media (max-width: 640px) {
		.cols {
			grid-template-columns: 1fr;
		}
	}
</style>
