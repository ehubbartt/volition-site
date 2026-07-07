<script lang="ts">
	import type { PageData } from './$types';
	import CardsTabs from '$lib/admin/CardsTabs.svelte';
	import { swrResource } from '$lib/swrResource.svelte';
	import { rsnToSlug } from '$lib/rsn';
	import { formatGP, formatPct } from '$lib/gp';
	import { formatDate } from '$lib/datetime';

	let { data: pageData }: { data: PageData } = $props();

	// Streamed payload (see +page.ts): revisits render the last-seen stats
	// instantly; first visits fill in as the fetch lands.
	const EMPTY_PACK_STATS = {
		totals: { opens: 0, vpSpent: 0, gpSpent: 0, cardsPulled: 0, openers: 0 },
		rarityBreak: [],
		finishPulls: { normal: 0, holo: 0, reverse: 0 },
		packBreakdown: [],
		playerStats: []
	} as NonNullable<PageData['packStats']['cached']>;
	const statsRes = swrResource(() => pageData.packStats, EMPTY_PACK_STATS);
	const data = $derived(statsRes.value);

	const fmt = (n: number) => n.toLocaleString();

	// Largest pull count, so the rarity bars scale to fill the row.
	let maxRarity = $derived(Math.max(1, ...data.rarityBreak.map((r) => r.count)));
	let finishTotal = $derived(
		data.finishPulls.normal + data.finishPulls.holo + data.finishPulls.reverse
	);

	const ago = formatDate;
	const pct = formatPct;
</script>

<svelte:head>
	<title>Pack Stats · Volition</title>
</svelte:head>

<section>
	<CardsTabs />
	<p class="muted">Card-game activity across all players — pack opens, VP spent, and collections.</p>

	<div class="summary">
		<div class="stat">
			<span class="num">{fmt(data.totals.opens)}</span>
			<span class="lbl">Packs opened</span>
		</div>
		<div class="stat">
			<span class="num">{fmt(data.totals.vpSpent)}</span>
			<span class="lbl">VP spent</span>
		</div>
		<div class="stat">
			<span class="num">{formatGP(data.totals.gpSpent)}</span>
			<span class="lbl">GP spent</span>
		</div>
		<div class="stat">
			<span class="num">{fmt(data.totals.cardsPulled)}</span>
			<span class="lbl">Cards pulled</span>
		</div>
		<div class="stat">
			<span class="num">{fmt(data.totals.openers)}</span>
			<span class="lbl">Players opening</span>
		</div>
	</div>

	{#if data.totals.opens === 0}
		<div class="empty">
			<p>No pack opens recorded yet.</p>
			<p class="muted">Opens are logged from the <a href="/gamba">store</a> going forward.</p>
		</div>
	{:else}
		<div class="two-col">
			<div class="card">
				<h2>Rarity pulls</h2>
				{#each data.rarityBreak as r (r.key)}
					<div class="bar-row">
						<span class="bar-label" style="color:{r.color}">{r.label}</span>
						<div class="bar-track">
							<div
								class="bar-fill"
								style="width:{(r.count / maxRarity) * 100}%; background:{r.color}"
							></div>
						</div>
						<span class="bar-count">{fmt(r.count)} · {pct(r.count, data.totals.cardsPulled)}</span>
					</div>
				{/each}
			</div>

			<div class="card">
				<h2>Finishes</h2>
				<div class="bar-row">
					<span class="bar-label">Normal</span>
					<div class="bar-track">
						<div
							class="bar-fill"
							style="width:{(data.finishPulls.normal / Math.max(1, finishTotal)) * 100}%; background:var(--muted)"
						></div>
					</div>
					<span class="bar-count">{fmt(data.finishPulls.normal)} · {pct(data.finishPulls.normal, finishTotal)}</span>
				</div>
				<div class="bar-row">
					<span class="bar-label">Holo</span>
					<div class="bar-track">
						<div
							class="bar-fill"
							style="width:{(data.finishPulls.holo / Math.max(1, finishTotal)) * 100}%; background:var(--accent)"
						></div>
					</div>
					<span class="bar-count">{fmt(data.finishPulls.holo)} · {pct(data.finishPulls.holo, finishTotal)}</span>
				</div>
				<div class="bar-row">
					<span class="bar-label">Reverse</span>
					<div class="bar-track">
						<div
							class="bar-fill"
							style="width:{(data.finishPulls.reverse / Math.max(1, finishTotal)) * 100}%; background:var(--yellow)"
						></div>
					</div>
					<span class="bar-count">{fmt(data.finishPulls.reverse)} · {pct(data.finishPulls.reverse, finishTotal)}</span>
				</div>
			</div>
		</div>

		<div class="card">
			<h2>By pack</h2>
			<table>
				<thead>
					<tr>
						<th>Pack</th>
						<th class="r">Opens</th>
						<th class="r">VP spent</th>
						<th class="r">GP spent</th>
						<th class="r">Cards pulled</th>
					</tr>
				</thead>
				<tbody>
					{#each data.packBreakdown as p (p.name)}
						<tr>
							<td>{p.name}</td>
							<td class="r">{fmt(p.opens)}</td>
							<td class="r">{fmt(p.vp)}</td>
							<td class="r">{p.gp > 0 ? formatGP(p.gp) : '—'}</td>
							<td class="r">{fmt(p.cards)}</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	{/if}

	<div class="card">
		<h2>By player</h2>
		{#if data.playerStats.length === 0}
			<p class="muted">No players have any card-game activity yet.</p>
		{:else}
			<div class="table-scroll">
				<table>
					<thead>
						<tr>
							<th>Player</th>
							<th class="r">Opened</th>
							<th class="r">VP spent</th>
							<th class="r">GP spent</th>
							<th class="r">Pulled</th>
							<th class="r">Packs held</th>
							<th class="r">Cards owned</th>
							<th class="r">Unique</th>
							<th class="r">Last open</th>
						</tr>
					</thead>
					<tbody>
						{#each data.playerStats as p (p.userId)}
							<tr>
								<td>
									{#if p.rsn}
										<a href="/u/{rsnToSlug(p.rsn)}">{p.name}</a>
									{:else}
										{p.name}
									{/if}
								</td>
								<td class="r">{fmt(p.packsOpened)}</td>
								<td class="r">{fmt(p.vpSpent)}</td>
								<td class="r">{p.gpSpent > 0 ? formatGP(p.gpSpent) : '—'}</td>
								<td class="r">{fmt(p.cardsPulled)}</td>
								<td class="r">{fmt(p.packsOwned)}</td>
								<td class="r">{fmt(p.cardsOwned)}</td>
								<td class="r">{fmt(p.uniqueCards)}</td>
								<td class="r">{ago(p.lastOpened)}</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		{/if}
	</div>
</section>

<style>
	.muted {
		color: var(--muted);
	}

	.summary {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(10rem, 1fr));
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

	.stat .num {
		font-family: var(--font-heading);
		font-size: 1.6rem;
		color: var(--accent);
	}

	.stat .lbl {
		font-size: 0.85rem;
		color: var(--muted);
	}

	.two-col {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(18rem, 1fr));
		gap: 1rem;
		margin-bottom: 1rem;
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

	.bar-row {
		display: grid;
		grid-template-columns: 5.5rem 1fr auto;
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
		transition: width 0.3s ease-out;
	}

	.bar-count {
		font-size: 0.8rem;
		color: var(--muted);
		white-space: nowrap;
	}

	.table-scroll {
		overflow-x: auto;
	}

	table {
		width: 100%;
		border-collapse: collapse;
		font-size: 0.9rem;
	}

	th,
	td {
		padding: 0.5rem 0.6rem;
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

	.empty {
		padding: 2.5rem 1rem;
		text-align: center;
		margin-bottom: 1rem;
	}

	.empty p {
		margin: 0.25rem 0;
	}
</style>
