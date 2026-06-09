<script lang="ts">
	import type { PageData } from './$types';
	import AccountIcon from '$lib/AccountIcon.svelte';
	import CardThumb from '$lib/cards/CardThumb.svelte';
	import PackThumb from '$lib/cards/PackThumb.svelte';
	import CardInspector3D from '$lib/cards/CardInspector3D.svelte';
	import type { UserCard } from '$lib/cards/rarity';
	import { CLAN_LABEL } from '$lib/clans';
	import type { ClanValue } from '$lib/clans';

	let { data }: { data: PageData } = $props();

	type Tab = 'collection' | 'packs' | 'wallet';
	let tab = $state<Tab>('collection');

	// Collection card the viewer modal is showing (null = closed).
	let viewing = $state<UserCard | null>(null);

	let tabs: { id: Tab; label: string }[] = [
		{ id: 'collection', label: 'Collection' },
		{ id: 'packs', label: 'Packs' },
		{ id: 'wallet', label: 'Wallet' }
	];

	let displayName = $derived(data.profileUser.rsn || data.profileUser.discord_username);
	let clanLabel = $derived(
		data.profileUser.clan_allegiance
			? CLAN_LABEL[data.profileUser.clan_allegiance as ClanValue]
			: null
	);
	let walletTotal = $derived(data.wallet.reduce((sum, w) => sum + w.quantity, 0));
	let packTotal = $derived(data.packs.reduce((sum, p) => sum + p.quantity, 0));
</script>

<svelte:head>
	<title>{displayName} · Volition</title>
</svelte:head>

<section class="profile">
	<header class="banner">
		<div class="identity">
			<AccountIcon type={data.profileUser.account_type} size={48} />
			<div class="who">
				<h1>{displayName}</h1>
				<span class="sub">
					@{data.profileUser.discord_username}{#if clanLabel} · {clanLabel}{/if}
				</span>
			</div>
		</div>
		<div class="vp" title="Volition Points">
			<span class="vp-amount">{data.vp_balance.toLocaleString()}</span>
			<span class="vp-label">VP</span>
		</div>
	</header>

	{#if data.isSelf}
		<p class="self-note muted">This is your public profile. <a href="/me">Edit your profile →</a></p>
	{/if}

	<div class="mini-stats">
		<div class="ms">
			<span class="ms-num">{data.stats.packsOpened}</span>
			<span class="ms-lbl">Packs opened</span>
		</div>
		<div class="ms">
			<span class="ms-num">{data.stats.vpSpent.toLocaleString()}</span>
			<span class="ms-lbl">VP spent</span>
		</div>
		<div class="ms">
			<span class="ms-num">{data.stats.cardsOwned}</span>
			<span class="ms-lbl">Cards owned</span>
		</div>
		<div class="ms">
			<span class="ms-num">{data.collectionOwned} / {data.collectionTotal}</span>
			<span class="ms-lbl">Collected</span>
		</div>
	</div>

	<nav class="tabs">
		{#each tabs as t}
			<button type="button" class="tab" class:active={tab === t.id} onclick={() => (tab = t.id)}>
				{t.label}
				{#if t.id === 'packs' && packTotal}
					<span class="count">{packTotal}</span>
				{:else if t.id === 'collection' && data.collectionOwned}
					<span class="count">{data.collectionOwned}</span>
				{:else if t.id === 'wallet' && walletTotal}
					<span class="count">{walletTotal}</span>
				{/if}
			</button>
		{/each}
	</nav>

	{#if tab === 'collection'}
		<div class="panel">
			{#if data.collection.length === 0}
				<div class="empty">
					<p>No cards to show.</p>
				</div>
			{:else}
				<div class="card-grid">
					{#each data.collection as card (card.id + '-' + card.finish)}
						{#if card.owned}
							<button type="button" class="thumb-btn" onclick={() => (viewing = card)}>
								<CardThumb {card} quantity={card.quantity} finish={card.finish} flip={false} />
							</button>
						{:else}
							<div class="thumb-btn locked" title="Not owned">
								<div class="dim"><CardThumb {card} flip={false} /></div>
							</div>
						{/if}
					{/each}
				</div>
			{/if}
		</div>
	{:else if tab === 'packs'}
		<div class="panel">
			{#if data.packs.length === 0}
				<div class="empty">
					<p>No packs.</p>
					<p class="muted">{displayName} has no unopened packs.</p>
				</div>
			{:else}
				<div class="card-grid">
					{#each data.packs as pack (pack.id)}
						<PackThumb {pack} quantity={pack.quantity} />
					{/each}
				</div>
			{/if}
		</div>
	{:else if tab === 'wallet'}
		<div class="panel">
			{#if data.wallet.length === 0}
				<div class="empty">
					<p>Wallet is empty.</p>
				</div>
			{:else}
				<ul class="wallet-list">
					{#each data.wallet as item}
						<li>
							<span class="item-name">{item.name}</span>
							<span class="item-qty">×{item.quantity}</span>
						</li>
					{/each}
				</ul>
			{/if}
		</div>
	{/if}
</section>

{#if viewing}
	<CardInspector3D card={viewing} onClose={() => (viewing = null)} />
{/if}

<style>
	.profile {
		max-width: 900px;
		margin: 0 auto;
	}

	.banner {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
		flex-wrap: wrap;
		padding: 1.5rem;
		background: linear-gradient(180deg, rgba(58, 48, 36, 0.9), rgba(40, 32, 24, 0.9));
		border: 1px solid var(--border);
		border-radius: var(--radius-lg);
		box-shadow: var(--shadow-card);
	}

	.identity {
		display: flex;
		align-items: center;
		gap: 1rem;
		min-width: 0;
	}

	.who {
		min-width: 0;
	}

	h1 {
		margin: 0;
		font-size: 1.8rem;
		line-height: 1.1;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.sub {
		color: var(--muted);
		font-size: 0.9rem;
	}

	.self-note {
		margin: 0.75rem 0 0;
		font-size: 0.85rem;
	}

	.vp {
		display: flex;
		align-items: baseline;
		gap: 0.4rem;
		padding: 0.5rem 1rem;
		background: var(--accent-soft);
		border: 1px solid var(--accent);
		border-radius: 999px;
		text-shadow: var(--ts);
	}

	.vp-amount {
		font-family: 'rsbold', ui-sans-serif, Arial, sans-serif;
		font-size: 1.4rem;
		color: var(--accent);
	}

	.vp-label {
		color: var(--accent);
		font-size: 0.85rem;
	}

	.mini-stats {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(7rem, 1fr));
		gap: 0.75rem;
		margin: 1.25rem 0;
	}

	.ms {
		display: flex;
		flex-direction: column;
		gap: 0.15rem;
		padding: 0.7rem 0.9rem;
		background: var(--surface-alt);
		border: 1px solid var(--border);
		border-radius: var(--radius);
	}

	.ms-num {
		font-family: 'rsbold', ui-sans-serif, Arial, sans-serif;
		font-size: 1.3rem;
		color: var(--accent);
		text-shadow: var(--ts);
	}

	.ms-lbl {
		font-size: 0.78rem;
		color: var(--muted);
	}

	.tabs {
		display: flex;
		gap: 0.25rem;
		margin: 0 0 1rem;
		border-bottom: 1px solid var(--border);
	}

	.tab {
		display: inline-flex;
		align-items: center;
		gap: 0.4rem;
		min-height: auto;
		padding: 0.55rem 1rem;
		background: transparent;
		border: none;
		border-bottom: 2px solid transparent;
		border-radius: 0;
		color: var(--muted);
		font-size: 1rem;
		cursor: pointer;
		transition: color 0.15s, border-color 0.15s;
	}

	.tab:hover {
		color: var(--text);
		background: transparent;
	}

	.tab.active {
		color: var(--accent);
		border-bottom-color: var(--accent);
	}

	.count {
		padding: 0.05rem 0.45rem;
		background: var(--surface-alt);
		border: 1px solid var(--border);
		border-radius: 999px;
		font-size: 0.75rem;
		color: var(--text);
	}

	.panel {
		animation: fade-in 0.2s ease-out;
	}

	@keyframes fade-in {
		from {
			opacity: 0;
			transform: translateY(4px);
		}
		to {
			opacity: 1;
			transform: none;
		}
	}

	.card-grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(9rem, 1fr));
		gap: 1rem;
	}

	.thumb-btn {
		display: block;
		padding: 0;
		margin: 0;
		min-height: auto;
		background: none;
		border: none;
		text-align: inherit;
		cursor: pointer;
		position: relative;
	}

	.thumb-btn.locked {
		cursor: default;
	}

	.thumb-btn.locked .dim {
		filter: grayscale(1) brightness(0.55);
		opacity: 0.9;
	}

	.empty {
		padding: 3rem 1rem;
		text-align: center;
	}

	.empty p {
		margin: 0.25rem 0;
	}

	.muted {
		color: var(--muted);
	}

	.wallet-list {
		list-style: none;
		padding: 0;
		margin: 0;
		display: flex;
		flex-direction: column;
		gap: 0.4rem;
	}

	.wallet-list li {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 0.6rem 0.85rem;
		background: var(--surface-alt);
		border: 1px solid var(--border);
		border-radius: var(--radius);
	}

	.item-qty {
		color: var(--muted);
	}

	@media (max-width: 480px) {
		h1 {
			font-size: 1.4rem;
		}
	}
</style>
