<script lang="ts">
	import type { PageData } from './$types';
	import { formatGP } from '$lib/gp';
	import { formatDate } from '$lib/datetime';
	import { enhance } from '$app/forms';
	import StatsTabs from '$lib/admin/StatsTabs.svelte';

	let { data }: { data: PageData } = $props();

	let search = $state('');
	let sortBy = $state<
		'rsn' | 'points' | 'gold_balance' | 'walletValue' | 'unpaidCount' | 'clan_joined_at'
	>('walletValue');
	let sortDir = $state<'asc' | 'desc'>('desc');
	let expanded = $state<string | number | null>(null);

	const fmt = (n: number) => n.toLocaleString();

	const ago = formatDate;

	function toggleSort(col: typeof sortBy) {
		if (sortBy === col) {
			sortDir = sortDir === 'asc' ? 'desc' : 'asc';
		} else {
			sortBy = col;
			sortDir = col === 'rsn' || col === 'clan_joined_at' ? 'asc' : 'desc';
		}
	}

	let filtered = $derived.by(() => {
		const q = search.trim().toLowerCase();
		let rows = data.players;
		if (q) {
			rows = rows.filter(
				(p) =>
					(p.rsn ?? '').toLowerCase().includes(q) ||
					String(p.discord_id ?? '').includes(q)
			);
		}
		const dir = sortDir === 'asc' ? 1 : -1;
		return [...rows].sort((a, b) => {
			let av: string | number = a[sortBy] ?? '';
			let bv: string | number = b[sortBy] ?? '';
			if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * dir;
			return String(av).toLowerCase().localeCompare(String(bv).toLowerCase()) * dir;
		});
	});

	const arrow = (col: typeof sortBy) => (sortBy !== col ? '' : sortDir === 'asc' ? ' ▲' : ' ▼');
</script>

<svelte:head>
	<title>Wallets · Volition Admin</title>
</svelte:head>

<section>
	<StatsTabs />
	<p class="muted">
		VP balances and the GP value of unpaid loot-crate items waiting in members' wallets.
	</p>

	<div class="summary">
		<div class="stat">
			<span class="num">{fmt(data.totals.members)}</span>
			<span class="lbl">Members</span>
		</div>
		<div class="stat">
			<span class="num">{fmt(data.totals.totalVP)}</span>
			<span class="lbl">Total VP</span>
		</div>
		<div class="stat">
			<span class="num">{formatGP(data.totals.goldBalance)}</span>
			<span class="lbl">GP balances</span>
		</div>
		<div class="stat">
			<span class="num">{formatGP(data.totals.walletValue)}</span>
			<span class="lbl">Wallet value (GP)</span>
		</div>
		<div class="stat">
			<span class="num">{fmt(data.totals.unpaidItems)}</span>
			<span class="lbl">Unpaid items</span>
		</div>
	</div>

	<div class="toolbar">
		<input
			class="search"
			type="search"
			placeholder="Search RSN or Discord ID…"
			bind:value={search}
		/>
		<span class="count">{filtered.length} shown</span>
	</div>

	<div class="card">
		<div class="table-scroll">
			<table>
				<thead>
					<tr>
						<th style="width:1.5rem"></th>
						<th class="click" onclick={() => toggleSort('rsn')}>RSN{arrow('rsn')}</th>
						<th>Discord ID</th>
						<th class="r click" onclick={() => toggleSort('points')}>VP{arrow('points')}</th>
						<th class="r click" onclick={() => toggleSort('gold_balance')}
							>GP bal{arrow('gold_balance')}</th
						>
						<th class="r click" onclick={() => toggleSort('walletValue')}
							>Wallet value{arrow('walletValue')}</th
						>
						<th class="r click" onclick={() => toggleSort('unpaidCount')}
							>Unpaid{arrow('unpaidCount')}</th
						>
						<th class="r click" onclick={() => toggleSort('clan_joined_at')}
							>Joined{arrow('clan_joined_at')}</th
						>
					</tr>
				</thead>
				<tbody>
					{#each filtered as p (p.id)}
						{@const isOpen = expanded === p.id}
						<tr
							class="row"
							class:open={isOpen}
							onclick={() => (expanded = isOpen ? null : p.id)}
						>
							<td class="caret">{isOpen ? '▾' : '▸'}</td>
							<td class="rsn">{p.rsn || '—'}</td>
							<td class="muted small">{p.discord_id || '—'}</td>
							<td class="r">{fmt(p.points)}</td>
							<td class="r">
								{#if p.gold_balance > 0}<span class="gp gold">{formatGP(p.gold_balance)}</span>{:else}<span
										class="muted">—</span
									>{/if}
							</td>
							<td class="r">
								{#if p.walletValue > 0}<span class="gp">{formatGP(p.walletValue)}</span>{:else}<span
										class="muted">—</span
									>{/if}
							</td>
							<td class="r">
								{#if p.unpaidCount > 0}<span class="badge">{p.unpaidCount}</span>{:else}<span
										class="muted">0</span
									>{/if}
							</td>
							<td class="r muted small">{ago(p.clan_joined_at)}</td>
						</tr>
						{#if isOpen}
							<tr class="detail">
								<td colspan="8">
									<div class="gp-settle">
										<span>
											GP balance: <strong class="gp gold">{formatGP(p.gold_balance)}</strong>
										</span>
										{#if p.gold_balance > 0}
											<form
												method="POST"
												action="?/settleGp"
												use:enhance
												onsubmit={(e) => {
													if (
														!confirm(
															`Zero ${p.rsn || p.discord_id}'s GP balance (${formatGP(p.gold_balance)})? GP is site-only (packs / event buy-ins, NOT claimable in-game) — only do this as a manual correction.`
														)
													)
														e.preventDefault();
												}}
											>
												<input type="hidden" name="id" value={p.id} />
												<button type="submit" class="settle-btn">Zero balance</button>
											</form>
										{/if}
									</div>
									{#if p.items.length === 0}
										<p class="muted empty">No items in wallet.</p>
									{:else}
										<div class="items">
											{#each p.items as it (it.id)}
												<div class="item" class:paid={it.paid_out}>
													<div class="item-top">
														<span class="item-name">{it.item_name}</span>
														<span class="pill {it.paid_out ? 'paid' : 'unpaid'}"
															>{it.paid_out ? 'Paid' : 'Unpaid'}</span
														>
													</div>
													<div class="item-meta">
														<span class="price"
															>{it.price > 0 ? formatGP(it.price) + ' GP' : 'Unknown value'}</span
														>
														{#if it.won_at}<span class="muted small">Won {ago(it.won_at)}</span>{/if}
													</div>
													{#if it.paid_out && it.paid_out_at}
														<div class="muted small payout">
															Paid {ago(it.paid_out_at)}{it.paid_out_by ? ` by ${it.paid_out_by}` : ''}
														</div>
													{/if}
												</div>
											{/each}
										</div>
									{/if}
								</td>
							</tr>
						{/if}
					{:else}
						<tr><td colspan="8" class="empty muted">No members found.</td></tr>
					{/each}
				</tbody>
			</table>
		</div>
	</div>
</section>

<style>
	.muted {
		color: var(--muted);
	}
	.small {
		font-size: 0.8rem;
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
	.stat .num {
		font-family: var(--font-heading);
		font-size: 1.5rem;
		color: var(--accent);
	}
	.stat .lbl {
		font-size: 0.85rem;
		color: var(--muted);
	}

	.toolbar {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		margin-bottom: 1rem;
	}
	.search {
		flex: 1;
		max-width: 22rem;
		padding: 0.5rem 0.7rem;
		background: var(--surface-alt);
		border: 1px solid var(--border);
		border-radius: var(--radius);
		color: var(--text);
		font-family: var(--font-body);
	}
	.search:focus {
		outline: none;
		border-color: var(--accent);
	}
	.count {
		color: var(--muted);
		font-size: 0.85rem;
	}

	.card {
		padding: 0.5rem;
		background: linear-gradient(180deg, rgba(58, 48, 36, 0.85), rgba(40, 32, 24, 0.85));
		border: 1px solid var(--border);
		border-radius: var(--radius);
		box-shadow: var(--shadow-card);
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
	th.click {
		cursor: pointer;
		user-select: none;
	}
	th.click:hover {
		color: var(--accent);
	}
	.row {
		cursor: pointer;
	}
	.row:hover {
		background: var(--surface-alt);
	}
	.row.open {
		background: var(--surface-alt);
	}
	.caret {
		color: var(--muted);
		text-align: center;
	}
	.rsn {
		color: var(--text);
	}
	.gp {
		color: var(--success);
	}
	.gp.gold {
		color: #e9c349;
	}
	.gp-settle {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
		flex-wrap: wrap;
		padding: 0.5rem 0.25rem 0.75rem;
		border-bottom: 1px dashed var(--border);
		margin-bottom: 0.5rem;
	}
	.settle-btn {
		border: 1px solid #e9c349;
		background: rgba(255, 215, 0, 0.1);
		color: #e9c349;
		padding: 0.35rem 0.7rem;
		border-radius: var(--radius);
		cursor: pointer;
		font-size: 0.85rem;
	}
	.settle-btn:hover {
		background: rgba(255, 215, 0, 0.2);
	}
	.badge {
		display: inline-block;
		padding: 0.05rem 0.45rem;
		border-radius: 3px;
		font-size: 0.78rem;
		background: var(--accent-soft);
		border: 1px solid var(--accent);
		color: var(--accent);
	}
	.detail td {
		background: rgba(0, 0, 0, 0.2);
	}
	.empty {
		text-align: center;
		padding: 1.5rem;
	}
	.items {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(15rem, 1fr));
		gap: 0.5rem;
		padding: 0.5rem 0;
	}
	.item {
		background: var(--surface-alt);
		border: 1px solid var(--border);
		border-radius: var(--radius);
		padding: 0.6rem 0.75rem;
	}
	.item.paid {
		opacity: 0.6;
	}
	.item-top {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.5rem;
		margin-bottom: 0.35rem;
	}
	.item-name {
		color: var(--text);
		font-size: 0.9rem;
	}
	.item-meta {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.5rem;
	}
	.price {
		color: var(--success);
		font-size: 0.85rem;
	}
	.payout {
		margin-top: 0.35rem;
		padding-top: 0.35rem;
		border-top: 1px solid var(--border);
	}
	.pill {
		display: inline-block;
		padding: 0.05rem 0.45rem;
		border-radius: 3px;
		font-size: 0.65rem;
		text-transform: uppercase;
		letter-spacing: 0.5px;
	}
	.pill.unpaid {
		background: var(--accent-soft);
		border: 1px solid var(--accent);
		color: var(--accent);
	}
	.pill.paid {
		background: var(--success-bg);
		border: 1px solid var(--success);
		color: var(--success);
	}
</style>
