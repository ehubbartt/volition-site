<script lang="ts">
	import type { PageData } from './$types';
	import { formatGP } from '$lib/gp';
	import { rankColor, rankLabel } from '$lib/ranks';
	import StatsTabs from '$lib/admin/StatsTabs.svelte';
	import { swrResource } from '$lib/swrResource.svelte';

	let { data: pageData }: { data: PageData } = $props();

	// Streamed payload (see +page.ts): revisits render the last-seen stats
	// instantly; first visits fill in as the fetch lands.
	const EMPTY_STATS: NonNullable<PageData['stats']['cached']> = {
		members: { totalMembers: 0, totalVP: 0, avgVP: 0, recentJoins: 0, playersWithVP: 0, recentLooters: 0 },
		flow: [],
		rankDistribution: [],
		topPlayers: [],
		wallet: { walletValue: 0, unpaidCount: 0, payoutQueue: [] },
		lootcrates: { total: 0, free: 0, paid: 0, item: 0, vp: 0 },
		crate7: { opens: 0, freeOpens: 0, paidOpens: 0, vpWon: 0, vpSpent: 0 },
		crate30: { opens: 0, freeOpens: 0, paidOpens: 0, vpWon: 0, vpSpent: 0 },
		avgOpensPerDay: 0,
		rareByDay: [],
		recentRareDrops: [],
		reroll: { total: 0, holders: 0 }
	};
	const statsRes = swrResource(() => pageData.stats, EMPTY_STATS);
	const data = $derived(statsRes.value);

	const fmt = (n: number) => n.toLocaleString();

	function shortDate(iso: string): string {
		const d = new Date(iso);
		const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
		return `${months[d.getMonth()]} ${d.getDate()}`;
	}
	function relTime(iso: string): string {
		const diff = Date.now() - new Date(iso).getTime();
		const mins = Math.floor(diff / 60_000);
		const hours = Math.floor(diff / 3_600_000);
		const days = Math.floor(diff / 86_400_000);
		if (mins < 1) return 'just now';
		if (mins < 60) return `${mins}m ago`;
		if (hours < 24) return `${hours}h ago`;
		if (days < 30) return `${days}d ago`;
		return shortDate(iso);
	}

	let maxFlow = $derived(Math.max(1, ...data.flow.map((d) => d.joins + d.leaves)));
	let maxRank = $derived(Math.max(1, ...data.rankDistribution.map((r) => r.count)));
	let maxRare = $derived(Math.max(1, ...data.rareByDay.map((d) => d.count)));
	let totalJoins = $derived(data.flow.reduce((s, d) => s + d.joins, 0));
	let totalLeaves = $derived(data.flow.reduce((s, d) => s + d.leaves, 0));
</script>

<svelte:head>
	<title>Clan Stats · Volition Admin</title>
</svelte:head>

<section>
	<StatsTabs />
	<p class="muted">Clan, economy, and loot-crate activity at a glance.</p>

	{#if !statsRes.ready}
		<p class="muted">Loading…</p>
	{/if}

	<div class="summary">
		<div class="stat"><span class="num">{fmt(data.members.totalMembers)}</span><span class="lbl">Members</span></div>
		<div class="stat"><span class="num">{fmt(data.members.totalVP)}</span><span class="lbl">Total VP</span></div>
		<div class="stat"><span class="num">{fmt(data.members.avgVP)}</span><span class="lbl">Avg VP / member</span></div>
		<div class="stat"><span class="num">{fmt(data.members.recentJoins)}</span><span class="lbl">Joins (30d)</span></div>
		<div class="stat"><span class="num">{fmt(data.members.playersWithVP)}</span><span class="lbl">Players with VP</span></div>
		<div class="stat"><span class="num">{fmt(data.members.recentLooters)}</span><span class="lbl">Looted (7d)</span></div>
	</div>

	<div class="card">
		<h2>Joins vs leaves (90 days)</h2>
		<div class="legend">
			<span><i class="sw join"></i> Joins · {totalJoins}</span>
			<span><i class="sw leave"></i> Leaves · {totalLeaves}</span>
		</div>
		<div class="chart">
			{#each data.flow as d (d.date)}
				<div class="col" title={`${shortDate(d.date)} · +${d.joins} / -${d.leaves}`}>
					<div class="seg join" style="height:{(d.joins / maxFlow) * 100}%"></div>
					<div class="seg leave" style="height:{(d.leaves / maxFlow) * 100}%"></div>
				</div>
			{/each}
		</div>
		{#if data.flow.length}
			<div class="chart-axis">
				<span>{shortDate(data.flow[0].date)}</span>
				<span>{shortDate(data.flow[data.flow.length - 1].date)}</span>
			</div>
		{/if}
	</div>

	<div class="two-col">
		<div class="card">
			<h2>Rank distribution</h2>
			{#each data.rankDistribution as r (r.rank)}
				<div class="bar-row">
					<span class="bar-label" style="color:{rankColor(r.rank)}">{rankLabel(r.rank)}</span>
					<div class="bar-track">
						<div class="bar-fill" style="width:{(r.count / maxRank) * 100}%; background:{rankColor(r.rank)}"></div>
					</div>
					<span class="bar-count">{fmt(r.count)}</span>
				</div>
			{/each}
		</div>

		<div class="card">
			<h2>Top players by VP</h2>
			<table>
				<tbody>
					{#each data.topPlayers as p, i (p.rsn + i)}
						<tr>
							<td class="muted" style="width:1.5rem">{i + 1}</td>
							<td>{p.rsn}</td>
							<td class="r">{fmt(p.points)}</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	</div>

	<div class="card">
		<h2>Wallet payout queue</h2>
		<p class="muted small">
			Total unpaid value: <strong class="gp">{formatGP(data.wallet.walletValue)} GP</strong> across
			{fmt(data.wallet.unpaidCount)} items. <a href="/admin/wallets">Open wallets →</a>
		</p>
		{#if data.wallet.payoutQueue.length > 0}
			<table>
				<thead><tr><th>Member</th><th class="r">Value</th><th class="r">Items</th></tr></thead>
				<tbody>
					{#each data.wallet.payoutQueue as q (q.rsn)}
						<tr><td>{q.rsn}</td><td class="r gp">{formatGP(q.value)}</td><td class="r">{q.count}</td></tr>
					{/each}
				</tbody>
			</table>
		{:else}
			<p class="muted">No unpaid items.</p>
		{/if}
	</div>

	<div class="summary">
		<div class="stat alt"><span class="num">{fmt(data.lootcrates.total)}</span><span class="lbl">Rare drops</span></div>
		<div class="stat alt"><span class="num">{fmt(data.lootcrates.item)}</span><span class="lbl">Item drops</span></div>
		<div class="stat alt"><span class="num">{fmt(data.lootcrates.vp)}</span><span class="lbl">VP drops</span></div>
		<div class="stat alt"><span class="num">{fmt(data.lootcrates.free)}</span><span class="lbl">From free crates</span></div>
		<div class="stat alt"><span class="num">{fmt(data.lootcrates.paid)}</span><span class="lbl">From paid crates</span></div>
		<div class="stat alt"><span class="num">{fmt(data.reroll.total)}</span><span class="lbl">Reroll tokens ({data.reroll.holders})</span></div>
	</div>

	<div class="two-col">
		<div class="card">
			<h2>Crate activity</h2>
			<table>
				<thead><tr><th></th><th class="r">7 days</th><th class="r">30 days</th></tr></thead>
				<tbody>
					<tr><td>Opens</td><td class="r">{fmt(data.crate7.opens)}</td><td class="r">{fmt(data.crate30.opens)}</td></tr>
					<tr><td>Free opens</td><td class="r">{fmt(data.crate7.freeOpens)}</td><td class="r">{fmt(data.crate30.freeOpens)}</td></tr>
					<tr><td>Paid opens</td><td class="r">{fmt(data.crate7.paidOpens)}</td><td class="r">{fmt(data.crate30.paidOpens)}</td></tr>
					<tr><td>VP won</td><td class="r">{fmt(data.crate7.vpWon)}</td><td class="r">{fmt(data.crate30.vpWon)}</td></tr>
					<tr><td>VP spent</td><td class="r">{fmt(data.crate7.vpSpent)}</td><td class="r">{fmt(data.crate30.vpSpent)}</td></tr>
				</tbody>
			</table>
			<p class="muted small">Avg {fmt(data.avgOpensPerDay)} opens/day (30d)</p>
		</div>

		<div class="card">
			<h2>Rare drops (30 days)</h2>
			<div class="chart short">
				{#each data.rareByDay as d (d.date)}
					<div class="col" title={`${shortDate(d.date)}: ${d.count}`}>
						<div class="seg accent" style="height:{(d.count / maxRare) * 100}%"></div>
					</div>
				{/each}
			</div>
			{#if data.rareByDay.length}
				<div class="chart-axis">
					<span>{shortDate(data.rareByDay[0].date)}</span>
					<span>{shortDate(data.rareByDay[data.rareByDay.length - 1].date)}</span>
				</div>
			{/if}
		</div>
	</div>

	<div class="card">
		<h2>Recent rare drops</h2>
		{#if data.recentRareDrops.length === 0}
			<p class="muted">No rare drops recorded.</p>
		{:else}
			<table>
				<thead>
					<tr><th>Member</th><th>Reward</th><th class="r">Chance</th><th class="r">Source</th><th class="r">When</th></tr>
				</thead>
				<tbody>
					{#each data.recentRareDrops as d (d.id)}
						<tr>
							<td>{d.rsn}</td>
							<td>{d.itemName}{d.dropType === 'vp' && d.amount ? ` (${fmt(d.amount)})` : ''}</td>
							<td class="r muted">{d.chancePercent != null ? `${d.chancePercent}%` : '—'}</td>
							<td class="r"><span class="pill {d.wasFree ? 'free' : 'paid'}">{d.wasFree ? 'Free' : 'Paid'}</span></td>
							<td class="r muted small">{relTime(d.timestamp)}</td>
						</tr>
					{/each}
				</tbody>
			</table>
		{/if}
	</div>
</section>

<style>
	.muted {
		color: var(--muted);
	}
	.small {
		font-size: 0.85rem;
	}
	.gp {
		color: var(--success);
	}
	a {
		color: var(--accent);
	}

	.summary {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(9rem, 1fr));
		gap: 1rem;
		margin: 1.5rem 0;
	}
	.stat {
		display: flex;
		flex-direction: column;
		gap: 0.2rem;
		padding: 1rem 1.25rem;
		background: var(--accent-soft);
		border: 1px solid var(--accent);
		border-radius: var(--radius);
		text-shadow: var(--ts);
	}
	.stat.alt {
		background: var(--surface);
		border-color: var(--border);
	}
	.stat .num {
		font-family: var(--font-heading);
		font-size: 1.5rem;
		color: var(--accent);
	}
	.stat .lbl {
		font-size: 0.82rem;
		color: var(--muted);
	}

	.two-col {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(20rem, 1fr));
		gap: 1rem;
	}

	.card {
		padding: 1.25rem;
		background: linear-gradient(180deg, rgba(58, 48, 36, 0.85), rgba(40, 32, 24, 0.85));
		border: 1px solid var(--border);
		border-radius: var(--radius);
		box-shadow: var(--shadow-card);
		margin-bottom: 1rem;
	}
	.card h2 {
		margin: 0 0 0.9rem;
		font-size: 1.1rem;
		color: var(--accent);
		text-shadow: var(--ts);
	}

	.legend {
		display: flex;
		gap: 1rem;
		font-size: 0.8rem;
		color: var(--muted);
		margin-bottom: 0.5rem;
	}
	.sw {
		display: inline-block;
		width: 0.7rem;
		height: 0.7rem;
		border-radius: 2px;
		vertical-align: middle;
		margin-right: 0.25rem;
	}
	.sw.join {
		background: var(--success);
	}
	.sw.leave {
		background: var(--danger);
	}

	.chart {
		display: flex;
		align-items: flex-end;
		gap: 1px;
		height: 130px;
	}
	.chart.short {
		height: 100px;
	}
	.col {
		flex: 1;
		height: 100%;
		display: flex;
		flex-direction: column;
		justify-content: flex-end;
	}
	.seg {
		width: 100%;
		min-height: 0;
	}
	.seg.join {
		background: var(--success);
	}
	.seg.leave {
		background: var(--danger);
	}
	.seg.accent {
		background: var(--accent);
		border-radius: 2px 2px 0 0;
	}
	.col:hover .seg {
		opacity: 0.7;
	}
	.chart-axis {
		display: flex;
		justify-content: space-between;
		margin-top: 0.4rem;
		font-size: 0.75rem;
		color: var(--muted);
	}

	.bar-row {
		display: grid;
		grid-template-columns: 6rem 1fr auto;
		align-items: center;
		gap: 0.6rem;
		margin-bottom: 0.5rem;
	}
	.bar-label {
		font-size: 0.85rem;
	}
	.bar-track {
		height: 0.7rem;
		background: var(--surface-alt);
		border: 1px solid var(--border);
		border-radius: 999px;
		overflow: hidden;
	}
	.bar-fill {
		height: 100%;
		border-radius: 999px;
	}
	.bar-count {
		font-size: 0.8rem;
		color: var(--muted);
	}

	table {
		width: 100%;
		border-collapse: collapse;
		font-size: 0.9rem;
	}
	th,
	td {
		padding: 0.4rem 0.55rem;
		text-align: left;
		border-bottom: 1px solid var(--border);
		white-space: nowrap;
	}
	th {
		color: var(--muted);
		font-weight: normal;
		font-size: 0.8rem;
	}
	th.r,
	td.r {
		text-align: right;
	}
	tbody tr:hover {
		background: var(--surface-alt);
	}

	.pill {
		display: inline-block;
		padding: 0.05rem 0.45rem;
		border-radius: 3px;
		font-size: 0.7rem;
	}
	.pill.free {
		background: var(--success-bg);
		border: 1px solid var(--success);
		color: var(--success);
	}
	.pill.paid {
		background: var(--accent-soft);
		border: 1px solid var(--accent);
		color: var(--accent);
	}
</style>
