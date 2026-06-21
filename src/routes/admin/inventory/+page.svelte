<script lang="ts">
	import { enhance } from '$app/forms';
	import { goto, invalidateAll } from '$app/navigation';
	import DatabaseTabs from '$lib/admin/DatabaseTabs.svelte';
	import { RARITY_BY_KEY, type CardRarity } from '$lib/cards/rarity';
	import { FINISH_BY_KEY, type CardFinish } from '$lib/cards/finishes';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	let search = $state('');
	let showAll = $state(false);
	let busy = $state(false);
	let msg = $state<string | null>(null);

	let filtered = $derived.by(() => {
		const q = search.trim().toLowerCase();
		let list = data.players;
		if (!showAll) list = list.filter((p) => p.hasInventory);
		if (q)
			list = list.filter(
				(p) =>
					(p.rsn ?? '').toLowerCase().includes(q) ||
					(p.discord_username ?? '').toLowerCase().includes(q) ||
					String(p.discord_id ?? '').includes(q)
			);
		return list.slice(0, 100);
	});

	function selectPlayer(id: string) {
		goto(`?user=${encodeURIComponent(id)}`, { invalidateAll: true, keepFocus: true });
	}

	function rarityColor(r: string): string {
		return RARITY_BY_KEY[r as CardRarity]?.color ?? '#888';
	}
	function finishLabel(f: string): string {
		return FINISH_BY_KEY[f as CardFinish]?.label ?? f;
	}

	// Shared enhance handler for every remove/wipe form.
	function act(label: string) {
		busy = true;
		return async ({ result }: { result: { type: string; data?: unknown } }) => {
			busy = false;
			if (result.type === 'success') {
				msg = `${label} ✓`;
				await invalidateAll();
			} else if (result.type === 'failure') {
				msg = (result.data as { error?: string })?.error ?? `${label} failed`;
			} else {
				msg = `${label} failed`;
			}
		};
	}

	const sel = $derived(data.selected);
</script>

<svelte:head>
	<title>Player Inventory · Volition Admin</title>
</svelte:head>

<section>
	<DatabaseTabs />
	<p class="muted">
		Remove individual cards/packs from a player, or wipe their whole inventory. Only players with a
		site account have card inventories.
	</p>

	{#if msg}<p class="toast">{msg}</p>{/if}

	<div class="layout">
		<!-- Player picker -->
		<aside class="picker">
			<input class="search" type="search" placeholder="Search player…" bind:value={search} />
			<label class="show-all">
				<input type="checkbox" bind:checked={showAll} /> Show all players
			</label>
			<ul class="players">
				{#each filtered as p (p.id)}
					<li>
						<button
							class="player"
							class:active={sel?.id === p.id}
							onclick={() => selectPlayer(p.id)}
						>
							<span class="p-name">{p.rsn || p.discord_username || '(no rsn)'}</span>
							{#if p.hasInventory}<span class="dot" title="Has inventory"></span>{/if}
						</button>
					</li>
				{:else}
					<li class="muted empty">No players.</li>
				{/each}
			</ul>
		</aside>

		<!-- Inventory -->
		<div class="content">
			{#if !sel}
				<div class="placeholder muted">Select a player to view their inventory.</div>
			{:else}
				<div class="head">
					<div>
						<h2>{sel.rsn || sel.discord_username || sel.id}</h2>
						<p class="muted small">
							{data.totals.cardStacks} card stacks ({data.totals.cardCopies} copies) ·
							{data.totals.packStacks} pack types ({data.totals.packCopies} unopened)
						</p>
					</div>
				</div>

				<!-- Cards -->
				<div class="card panel">
					<div class="panel-head">
						<h3>Cards ({data.cards.length})</h3>
						{#if data.cards.length > 0}
							<form
								method="POST"
								action="?/wipeCards"
								use:enhance={() => act('Wiped all cards')}
							>
								<input type="hidden" name="user_id" value={sel.id} />
								<button
									type="submit"
									class="danger"
									disabled={busy}
									onclick={(e) => {
										if (!confirm(`Delete ALL ${data.cards.length} card stacks from this player? This cannot be undone.`)) e.preventDefault();
									}}>Wipe all cards</button
								>
							</form>
						{/if}
					</div>
					{#if data.cards.length === 0}
						<p class="muted empty">No cards.</p>
					{:else}
						<ul class="items">
							{#each data.cards as c (c.id)}
								<li class="item">
									<span class="rdot" style="background:{rarityColor(c.rarity)}"></span>
									{#if c.front_url}<img class="thumb" src={c.front_url} alt="" loading="lazy" />{/if}
									<span class="i-name">{c.name}</span>
									{#if c.finish !== 'normal'}<span class="finish">{finishLabel(c.finish)}</span>{/if}
									<span class="qty">×{c.quantity}</span>
									<form method="POST" action="?/removeCard" use:enhance={() => act('Removed card')}>
										<input type="hidden" name="id" value={c.id} />
										<input type="hidden" name="user_id" value={sel.id} />
										<button
											type="submit"
											class="rm"
											disabled={busy}
											onclick={(e) => {
												if (!confirm(`Remove ${c.name}${c.finish !== 'normal' ? ' (' + finishLabel(c.finish) + ')' : ''} ×${c.quantity}?`)) e.preventDefault();
											}}
											title="Remove">✕</button
										>
									</form>
								</li>
							{/each}
						</ul>
					{/if}
				</div>

				<!-- Packs -->
				<div class="card panel">
					<div class="panel-head">
						<h3>Unopened packs ({data.packs.length})</h3>
						{#if data.packs.length > 0}
							<form
								method="POST"
								action="?/wipePacks"
								use:enhance={() => act('Wiped all packs')}
							>
								<input type="hidden" name="user_id" value={sel.id} />
								<button
									type="submit"
									class="danger"
									disabled={busy}
									onclick={(e) => {
										if (!confirm('Delete ALL unopened packs from this player? This cannot be undone.')) e.preventDefault();
									}}>Wipe all packs</button
								>
							</form>
						{/if}
					</div>
					{#if data.packs.length === 0}
						<p class="muted empty">No packs.</p>
					{:else}
						<ul class="items">
							{#each data.packs as p (p.id)}
								<li class="item">
									{#if p.front_url}<img class="thumb" src={p.front_url} alt="" loading="lazy" />{/if}
									<span class="i-name">{p.name}</span>
									<span class="qty">×{p.quantity}</span>
									<form method="POST" action="?/removePack" use:enhance={() => act('Removed pack')}>
										<input type="hidden" name="id" value={p.id} />
										<input type="hidden" name="user_id" value={sel.id} />
										<button
											type="submit"
											class="rm"
											disabled={busy}
											onclick={(e) => {
												if (!confirm(`Remove ${p.name} ×${p.quantity}?`)) e.preventDefault();
											}}
											title="Remove">✕</button
										>
									</form>
								</li>
							{/each}
						</ul>
					{/if}
				</div>
			{/if}
		</div>
	</div>
</section>

<style>
	.muted {
		color: var(--muted);
	}
	.small {
		font-size: 0.85rem;
	}
	.empty {
		padding: 0.75rem 0;
	}
	.toast {
		margin: 0 0 1rem;
		padding: 0.5rem 0.75rem;
		background: var(--surface-alt);
		border: 1px solid var(--border);
		border-left: 3px solid var(--accent);
		border-radius: var(--radius);
		font-size: 0.88rem;
	}

	.layout {
		display: grid;
		grid-template-columns: 16rem 1fr;
		gap: 1rem;
		align-items: start;
	}
	@media (max-width: 720px) {
		.layout {
			grid-template-columns: 1fr;
		}
	}

	.picker {
		background: var(--surface);
		border: 1px solid var(--border);
		border-radius: var(--radius);
		padding: 0.6rem;
		position: sticky;
		top: 1rem;
	}
	.search {
		width: 100%;
		padding: 0.45rem 0.6rem;
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
	.show-all {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		font-size: 0.78rem;
		color: var(--muted);
		margin: 0.5rem 0.1rem;
	}
	.players {
		list-style: none;
		margin: 0;
		padding: 0;
		max-height: 60vh;
		overflow-y: auto;
	}
	.player {
		width: 100%;
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.5rem;
		padding: 0.4rem 0.55rem;
		background: none;
		border: 1px solid transparent;
		border-radius: var(--radius);
		color: var(--text);
		font-family: var(--font-body);
		text-align: left;
		cursor: pointer;
	}
	.player:hover {
		background: var(--surface-alt);
	}
	.player.active {
		background: var(--accent-soft);
		border-color: var(--accent);
		color: var(--accent);
	}
	.p-name {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.dot {
		width: 0.45rem;
		height: 0.45rem;
		border-radius: 50%;
		background: var(--success);
		flex: 0 0 auto;
	}

	.placeholder {
		padding: 3rem 1rem;
		text-align: center;
		border: 1px dashed var(--border);
		border-radius: var(--radius);
	}
	.head h2 {
		margin: 0;
		font-size: 1.2rem;
		color: var(--accent);
		text-shadow: var(--ts);
	}

	.panel {
		padding: 1rem;
		background: linear-gradient(180deg, rgba(58, 48, 36, 0.85), rgba(40, 32, 24, 0.85));
		border: 1px solid var(--border);
		border-radius: var(--radius);
		box-shadow: var(--shadow-card);
		margin-top: 1rem;
	}
	.panel-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
		margin-bottom: 0.6rem;
	}
	.panel-head h3 {
		margin: 0;
		font-size: 1rem;
		color: var(--accent);
	}

	.items {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 0.3rem;
	}
	.item {
		display: flex;
		align-items: center;
		gap: 0.6rem;
		padding: 0.35rem 0.4rem;
		border-bottom: 1px solid var(--border);
	}
	.item:last-child {
		border-bottom: none;
	}
	.rdot {
		width: 0.55rem;
		height: 0.55rem;
		border-radius: 50%;
		flex: 0 0 auto;
	}
	.thumb {
		width: 1.8rem;
		height: 2.5rem;
		object-fit: cover;
		border-radius: 3px;
		border: 1px solid var(--border);
		background: #000;
		flex: 0 0 auto;
	}
	.i-name {
		flex: 1;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.finish {
		font-size: 0.68rem;
		text-transform: uppercase;
		letter-spacing: 0.5px;
		color: var(--yellow);
		border: 1px solid rgba(255, 255, 0, 0.3);
		background: rgba(255, 255, 0, 0.08);
		border-radius: 999px;
		padding: 0.05rem 0.4rem;
		flex: 0 0 auto;
	}
	.qty {
		color: var(--muted);
		font-size: 0.85rem;
		flex: 0 0 auto;
	}
	.rm {
		padding: 0.15rem 0.45rem;
		background: var(--surface);
		border: 1px solid var(--border);
		border-radius: var(--radius);
		color: var(--muted);
		cursor: pointer;
		font-size: 0.8rem;
	}
	.rm:hover:not(:disabled) {
		border-color: var(--danger);
		color: var(--danger);
	}
	.rm:disabled {
		opacity: 0.4;
		cursor: not-allowed;
	}
	.danger {
		padding: 0.35rem 0.7rem;
		background: var(--danger-bg);
		border: 1px solid var(--danger);
		border-radius: var(--radius);
		color: var(--danger);
		font-family: var(--font-body);
		font-size: 0.82rem;
		cursor: pointer;
	}
	.danger:hover:not(:disabled) {
		background: var(--danger);
		color: #fff;
	}
	.danger:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}
</style>
