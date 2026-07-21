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
	// Auto-chained refresh: one click sweeps the whole clan. `runSince` stamps the
	// pass (the server only fetches members not yet updated in this pass and reports
	// `remaining`); the enhance callback resubmits until remaining is 0 or Stop.
	let runSince = $state<string | null>(null);
	let stopRequested = $state(false);
	let refreshRemaining = $state<number | null>(null);
	let refreshRetries = $state(0); // consecutive retryable failures (WOM rate-limit backoff)
	let refreshForm = $state<HTMLFormElement>();
	// Skip members who already have Temple data — a fast top-up that only fetches players
	// still missing collection-log data (new members / prior Temple outages). Uncheck for a
	// full re-fetch of everyone's current stats.
	let skipTracked = $state(true);
	const MAX_REFRESH_RETRIES = 5;
	const RETRY_DELAY_MS = 25_000; // long enough for WOM's per-minute window to reset
	let recalcing = $state(false);
	let applying = $state(false);
	let applyOpen = $state(false);
	let applyForm = $state<HTMLFormElement>();

	// Live comparison (new-system projection vs in-game WOM roles).
	let comparing = $state(false);
	let showAllCompared = $state(false);
	let comparison = $derived(
		form && 'comparison' in form && form.comparison ? form.comparison : null
	);
	// The interesting rows are the movers; "show all" adds unchanged + staff roles.
	let comparedRows = $derived(
		comparison
			? showAllCompared
				? comparison.players
				: comparison.players.filter((p) => p.delta != null && p.delta !== 0)
			: []
	);
	let maxDeltaCount = $derived(
		comparison ? Math.max(1, ...comparison.deltaHist.map((d) => d.count)) : 1
	);
	// Shared scale across the in-game and projected histograms so the bars compare 1:1.
	let maxCmpDist = $derived(
		comparison ? Math.max(1, ...comparison.dist.map((d) => Math.max(d.inGame, d.projected))) : 1
	);
	const pctOf = (n: number, total: number) => (total ? Math.round((n / total) * 100) : 0);

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
		['c_gear', 'gear', 'Gear cap (0 = table sum)'],
		['c_months', 'months', 'Months cap'],
		['c_clog', 'clog', 'Clog slots cap'],
		['c_levelMin', 'levelMin', 'Level floor'],
		['c_levelRange', 'levelRange', 'Level range']
	] as const;

	// Diminishing-returns exponents for gear/EHB (1 = linear, 0.5 = sqrt — front-loads
	// early progress so the mid-game isn't flat).
	const curveKeys = [
		['curve_gear', 'gear', 'Gear curve'],
		['curve_ehb', 'ehb', 'EHB curve']
	] as const;

	let weightSum = $derived(
		Object.values(config.weights).reduce((s: number, n) => s + (n as number), 0)
	);
	function thr(role: string): number {
		return config.thresholds.find((t) => t.womRole === role)?.scoreMin ?? 0;
	}
	// Shared scale across the projected and current charts so their bars compare 1:1.
	let maxRankCount = $derived(
		Math.max(1, ...summary.distribution.map((d) => Math.max(d.projected, d.current)))
	);
</script>

<svelte:head>
	<title>Rank Sim · Admin · Volition</title>
</svelte:head>

<section class="wrap">
	<h1>Rank Simulator</h1>
	<p class="muted">
		Re-score the whole clan from cached data as you tune the composite weights and thresholds,
		then save the config live or apply the projected ranks to <code>players.rank</code>. Now that
		ranks are live, the comparison below tracks how the system's projections line up with the
		ranks members actually hold in game.
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
						{#if refreshing}
							Fetching… {form.cachedCount}/{form.rosterSize} cached · {refreshRemaining ?? '?'}
							left in this pass.
						{:else if 'remaining' in form && form.remaining === 0}
							Done — {form.cachedCount}/{form.rosterSize} cached.
						{:else}
							Stopped. {form.cachedCount}/{form.rosterSize} cached.
						{/if}
					</p>
				{:else if form && 'refreshError' in form && form.refreshError}
					<p class="err small">
						{form.refreshError}
						{#if refreshing && refreshRetries > 0}
							Retrying automatically ({refreshRetries}/{MAX_REFRESH_RETRIES})…
						{/if}
					</p>
				{/if}
			</div>
			<form
				method="POST"
				action="?/refresh"
				bind:this={refreshForm}
				use:enhance={({ formData }) => {
					// Stamp the pass on the first batch; every chained batch reuses it so
					// the server can tell what's already been refreshed this run.
					if (!runSince) runSince = new Date().toISOString();
					formData.set('since', runSince);
					formData.set('onlyMissing', skipTracked ? '1' : '0');
					refreshing = true;
					return async ({ update, result }) => {
						await update({ reset: false });
						// Transient WOM failure (rate-limit/outage): back off and retry the
						// same batch instead of aborting the sweep.
						const retryable =
							result.type === 'failure' && !!result.data && result.data.refreshRetryable === true;
						if (retryable && !stopRequested && refreshRetries < MAX_REFRESH_RETRIES) {
							refreshRetries += 1;
							setTimeout(() => refreshForm?.requestSubmit(), RETRY_DELAY_MS);
							return;
						}
						const remaining =
							result.type === 'success' && result.data && typeof result.data.remaining === 'number'
								? result.data.remaining
								: 0;
						refreshRemaining = remaining;
						if (result.type === 'success') refreshRetries = 0;
						if (result.type === 'success' && remaining > 0 && !stopRequested) {
							// Keep sweeping — the server's per-player delay handles rate limits;
							// this pause just spaces the requests.
							setTimeout(() => refreshForm?.requestSubmit(), 300);
						} else {
							refreshing = false;
							runSince = null;
							stopRequested = false;
							refreshRetries = 0;
						}
					};
				}}
			>
				<button class="btn" type="submit" disabled={refreshing}>
					{refreshing ? 'Fetching…' : skipTracked ? 'Fetch missing' : 'Refresh all'}
				</button>
				{#if refreshing}
					<button class="btn" type="button" onclick={() => (stopRequested = true)}>
						Stop after this batch
					</button>
				{/if}
				<label class="skip-toggle">
					<input type="checkbox" bind:checked={skipTracked} disabled={refreshing} />
					<span>Skip players who already have Temple data</span>
				</label>
			</form>
		</div>
	</div>

	<!-- Live comparison: new system vs in-game ranks ------------------------ -->
	<div class="card">
		<div class="row between">
			<div>
				<strong>New system vs in-game ranks</strong>
				<p class="muted small">
					Scores the cached players with the <strong>saved live config</strong> and compares
					against the rank each member holds in game right now (their WOM group role).
					Refresh the cache first if the numbers should reflect today's stats.
				</p>
				{#if form && 'compareError' in form && form.compareError}
					<p class="err small">{form.compareError}</p>
				{/if}
			</div>
			<form
				method="POST"
				action="?/compare"
				use:enhance={() => {
					comparing = true;
					return async ({ update }) => {
						await update({ reset: false });
						comparing = false;
						showAllCompared = false;
					};
				}}
			>
				<button class="btn primary" type="submit" disabled={comparing}>
					{comparing ? 'Comparing…' : 'Compare vs in-game'}
				</button>
			</form>
		</div>

		{#if comparison}
			<div class="cmp-chips">
				<span class="chip chip-up">↑ {comparison.up} would rank up</span>
				<span class="chip chip-down">↓ {comparison.down} would rank down</span>
				<span class="chip">= {comparison.same} unchanged ({pctOf(comparison.same, comparison.compared)}%)</span>
				<span class="chip">avg move {comparison.avgAbsDelta} rank(s)</span>
			</div>
			<p class="muted small">
				{comparison.compared} of {comparison.rosterSize} members compared · {comparison.noTemple}
				excluded (no Temple data) · {comparison.notCached} not in the cache yet ·
				{comparison.estimatedBaseline} with staff/special WOM roles included via an EHB-estimated
				current rank.
				<code>players.rank</code> already matches the projection for
				{comparison.storedMatches}/{comparison.storedCompared}.
			</p>

			<strong class="mt">Current ranks <span class="hint">(in game; staff/special estimated from EHB)</span></strong>
			<div class="rank-hist">
				{#each comparison.dist as d (d.rank)}
					<div class="rcol" title={`${d.label}: ${d.inGame} in game · ${d.projected} projected`}>
						<span class="rcount">{d.inGame}</span>
						<div class="rtrack">
							<div
								class="rbar"
								style="height:{(d.inGame / maxCmpDist) * 100}%; background:{rankColor(d.rank)}"
							></div>
						</div>
						<span class="rlbl" style="color:{rankColor(d.rank)}">{d.label}</span>
					</div>
				{/each}
			</div>

			<strong class="mt">Ranks under the new system (projected)</strong>
			<div class="rank-hist">
				{#each comparison.dist as d (d.rank)}
					<div class="rcol" title={`${d.label}: ${d.projected} projected · ${d.inGame} in game`}>
						<span class="rcount">{d.projected}</span>
						<div class="rtrack">
							<div
								class="rbar"
								style="height:{(d.projected / maxCmpDist) * 100}%; background:{rankColor(d.rank)}"
							></div>
						</div>
						<span class="rlbl" style="color:{rankColor(d.rank)}">{d.label}</span>
					</div>
				{/each}
			</div>

			<strong class="mt">Movement (projected − in-game, in rank steps)</strong>
			<div class="rank-hist">
				{#each comparison.deltaHist as d (d.delta)}
					<div class="rcol" title="{d.count} member(s) at {d.delta > 0 ? '+' : ''}{d.delta}">
						<span class="rcount">{d.count}</span>
						<div class="rtrack">
							<div
								class="rbar"
								style="height:{(d.count / maxDeltaCount) * 100}%; background:{d.delta > 0
									? 'var(--success, #6aa84f)'
									: d.delta < 0
										? 'var(--danger)'
										: 'var(--muted)'}"
							></div>
						</div>
						<span class="rlbl">{d.delta > 0 ? '+' : ''}{d.delta}</span>
					</div>
				{/each}
			</div>

			<strong class="mt">
				{showAllCompared ? `All compared members (${comparison.players.length})` : `Movers (${comparedRows.length})`}
			</strong>
			<div class="tablewrap">
				<table class="players">
					<thead>
						<tr><th>RSN</th><th>In game</th><th>Projected</th><th>Δ</th><th>Stored</th><th>Score</th></tr>
					</thead>
					<tbody>
						{#each comparedRows as p (p.rsn)}
							<tr>
								<td>{p.rsn}</td>
								<td
									title={p.estimated
										? `No mapped in-game rank (WOM role: ${p.womRole ?? '—'}) — estimated from EHB via the legacy ladder`
										: ''}
								>
									{#if p.womRank}<span style="color:{rankColor(p.womRank)}">{p.womRank}</span>{/if}
									{#if p.estimated}<span class="est-tag">est</span>{/if}
								</td>
								<td><span style="color:{rankColor(p.projected)}">{p.projected}</span></td>
								<td class:up={p.delta != null && p.delta > 0} class:down={p.delta != null && p.delta < 0}>
									{p.delta == null ? '—' : p.delta > 0 ? `+${p.delta}` : p.delta}
								</td>
								<td>
									{#if p.stored}<span style="color:{rankColor(p.stored)}">{p.stored}</span>
									{:else}<span class="muted">—</span>{/if}
								</td>
								<td>{p.composite.toFixed(4)}</td>
							</tr>
						{:else}
							<tr><td colspan="6" class="muted">Nobody moves — the new system agrees with every in-game rank.</td></tr>
						{/each}
					</tbody>
				</table>
			</div>
			{#if !showAllCompared && comparison.players.length > comparedRows.length}
				<button class="btn cmp-showall" type="button" onclick={() => (showAllCompared = true)}>
					Show all {comparison.players.length} compared members
				</button>
			{/if}
		{/if}
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

			<strong class="mt">Progression curves <span class="hint">(1 = linear · 0.5 = sqrt, front-loads early progress)</span></strong>
			<div class="grid">
				{#each curveKeys as [name, key, label]}
					<label>
						<span>{label}</span>
						<input type="number" step="0.05" min="0.2" max="1" {name} value={config.curves[key]} />
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

			<label class="chk mt">
				<input
					type="checkbox"
					name="excludeNoTemple"
					value="1"
					checked={form && 'excludeNoTemple' in form ? !!form.excludeNoTemple : false}
				/>
				<span>
					Exclude players without Temple data — their gear/clog score 0 through no fault of
					their own, which skews the distribution
				</span>
			</label>

			<div class="row gap mt">
				<button class="btn primary" type="submit" disabled={recalcing}>
					{recalcing ? 'Recalculating…' : 'Recalculate'}
				</button>
				<button class="btn" type="submit" name="save" value="1" disabled={recalcing}>
					Save as live config & recalc
				</button>
				<button class="btn" type="submit" formaction="?/suggest" disabled={recalcing}>
					Suggest right-skewed thresholds
				</button>
				{#if form && 'saved' in form && form.saved}<span class="ok small">Saved live.</span>{/if}
				{#if form && 'saveError' in form && form.saveError}<span class="err small">{form.saveError}</span>{/if}
				{#if form && 'suggestOk' in form && form.suggestOk}
					<span class="ok small">
						Thresholds suggested from {form.suggestedFrom} players' actual scores — the preview
						below already uses them. Save to make live.
					</span>
				{/if}
				{#if form && 'suggestError' in form && form.suggestError}
					<span class="err small">{form.suggestError}</span>
				{/if}
			</div>
		</div>
	</form>

	<!-- Distribution ------------------------------------------------------- -->
	<div class="card">
		<strong>
			Rank distribution ({summary.total} players){#if summary.excludedNoTemple > 0}
				<span class="muted small">· {summary.excludedNoTemple} hidden (no Temple data)</span>
			{/if}
		</strong>
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

		<strong class="mt">Players per rank (projected)</strong>
		<div class="rank-hist">
			{#each summary.distribution as d (d.rank)}
				<div class="rcol" title={`${d.label}: ${d.projected} projected · ${d.current} current`}>
					<span class="rcount">{d.projected}</span>
					<div class="rtrack">
						<div
							class="rbar"
							style="height:{(d.projected / maxRankCount) * 100}%; background:{rankColor(d.rank)}"
						></div>
					</div>
					<span class="rlbl" style="color:{rankColor(d.rank)}">{d.label}</span>
				</div>
			{/each}
		</div>

		<strong class="mt">Players per rank (current)</strong>
		<div class="rank-hist">
			{#each summary.distribution as d (d.rank)}
				<div class="rcol" title={`${d.label}: ${d.current} current · ${d.projected} projected`}>
					<span class="rcount">{d.current}</span>
					<div class="rtrack">
						<div
							class="rbar"
							style="height:{(d.current / maxRankCount) * 100}%; background:{rankColor(d.rank)}"
						></div>
					</div>
					<span class="rlbl" style="color:{rankColor(d.rank)}">{d.label}</span>
				</div>
			{/each}
		</div>
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
	/* .btn uses the base OSRS bronze button (app.css); variants just retint text. */
	.btn.primary {
		color: var(--accent);
		font-family: var(--font-heading);
	}
	.btn.danger {
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
	/* Players-per-rank histogram: one colored column per rank. The track has a
	   fixed height so the bar's PERCENTAGE height has something to resolve against. */
	.rank-hist {
		display: flex;
		align-items: flex-end;
		gap: 0.6rem;
		margin-top: 0.6rem;
	}
	.rcol {
		flex: 1;
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 0.25rem;
		min-width: 0;
	}
	.rcount {
		font-size: 0.8rem;
		font-family: var(--font-heading);
		color: var(--text);
	}
	.rtrack {
		width: 100%;
		height: 110px;
		display: flex;
		align-items: flex-end;
		background: var(--surface);
		border-radius: 3px;
	}
	.rbar {
		width: 100%;
		border-radius: 3px;
		min-height: 2px;
	}
	.rlbl {
		font-size: 0.68rem;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		max-width: 100%;
	}
	.chk {
		display: flex;
		align-items: flex-start;
		gap: 0.45rem;
		font-size: 0.85rem;
		color: var(--muted);
		cursor: pointer;
		max-width: 38rem;
	}
	.chk input {
		margin-top: 0.15rem;
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
	/* Live-comparison stat chips + show-all control */
	.cmp-chips {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
		margin: 0.9rem 0 0.4rem;
	}
	.cmp-chips .chip {
		padding: 0.3rem 0.65rem;
		background: var(--surface);
		border: 1px solid var(--border);
		border-radius: 999px;
		font-size: 0.82rem;
	}
	.cmp-chips .chip-up {
		color: var(--success, #6aa84f);
		border-color: var(--success, #6aa84f);
	}
	.cmp-chips .chip-down {
		color: var(--danger);
		border-color: var(--danger);
	}
	.cmp-showall {
		margin-top: 0.6rem;
	}
	@media (max-width: 640px) {
		.cols {
			grid-template-columns: 1fr;
		}
	}
	.skip-toggle {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		margin-top: 0.5rem;
		font-size: 0.8rem;
		color: var(--muted);
		cursor: pointer;
	}
	.skip-toggle input {
		cursor: pointer;
	}
	.hint {
		font-weight: 400;
		font-size: 0.78rem;
		color: var(--muted);
	}
	.est-tag {
		margin-left: 0.25rem;
		font-size: 0.6rem;
		text-transform: uppercase;
		letter-spacing: 0.03em;
		color: var(--muted);
		border: 1px solid var(--border);
		border-radius: 3px;
		padding: 0 0.2rem;
		vertical-align: middle;
	}
</style>
