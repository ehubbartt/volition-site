<script lang="ts">
	import type { PageData, ActionData } from './$types';
	import AccountIcon from '$lib/AccountIcon.svelte';
	import CardThumb from '$lib/cards/CardThumb.svelte';
	import PackThumb from '$lib/cards/PackThumb.svelte';
	import { CLAN_LABEL } from '$lib/clans';
	import type { ClanValue } from '$lib/clans';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	type Tab = 'profile' | 'packs' | 'collection' | 'wallet';
	let tab = $state<Tab>('profile');

	const tabs: { id: Tab; label: string }[] = [
		{ id: 'profile', label: 'Profile' },
		{ id: 'packs', label: 'Packs' },
		{ id: 'collection', label: 'Collection' },
		{ id: 'wallet', label: 'Wallet' }
	];

	let clanLabel = $derived(
		data.user.clan_allegiance ? CLAN_LABEL[data.user.clan_allegiance as ClanValue] : null
	);
	let walletTotal = $derived(data.wallet.reduce((sum, w) => sum + w.quantity, 0));
	let packTotal = $derived(data.packs.reduce((sum, p) => sum + p.quantity, 0));
</script>

<svelte:head>
	<title>Profile · Volition</title>
</svelte:head>

<section class="profile">
	<header class="banner">
		<div class="identity">
			<AccountIcon type={data.user.account_type} size={48} />
			<div class="who">
				<h1>{data.user.rsn ?? data.user.discord_username}</h1>
				<span class="sub">
					@{data.user.discord_username}{#if clanLabel} · {clanLabel}{/if}
				</span>
			</div>
		</div>
		<div class="vp" title="Volition Points">
			<span class="vp-amount">{data.vp_balance.toLocaleString()}</span>
			<span class="vp-label">VP</span>
		</div>
	</header>

	<nav class="tabs">
		{#each tabs as t}
			<button
				type="button"
				class="tab"
				class:active={tab === t.id}
				onclick={() => (tab = t.id)}
			>
				{t.label}
				{#if t.id === 'packs' && packTotal}
					<span class="count">{packTotal}</span>
				{:else if t.id === 'collection' && data.collection.length}
					<span class="count">{data.collection.length}</span>
				{:else if t.id === 'wallet' && walletTotal}
					<span class="count">{walletTotal}</span>
				{/if}
			</button>
		{/each}
	</nav>

	{#if tab === 'profile'}
		<div class="panel">
			{#if form?.success}
				<div class="success">Saved.</div>
			{:else if form?.error}
				<div class="error">{form.error}</div>
			{/if}

			<form method="POST" class="edit">
				<label>
					<span>OSRS RSN</span>
					<input name="rsn" type="text" maxlength="12" required value={data.user.rsn ?? ''} />
				</label>

				<fieldset class="account-picker">
					<legend>Account type</legend>
					<div class="account-options">
						{#each data.accountTypes as opt}
							<label class="account-option" title={opt.label}>
								<input
									type="radio"
									name="account_type"
									value={opt.value}
									checked={data.user.account_type === opt.value}
									required
								/>
								<span class="opt-card">
									<img src={opt.icon} alt={opt.label} class="opt-icon" />
								</span>
							</label>
						{/each}
					</div>
				</fieldset>

				<label>
					<span>Clan allegiance</span>
					<select name="clan_allegiance" required>
						<option value="" disabled selected={!data.user.clan_allegiance}>Pick a clan…</option>
						{#each data.clanOptions as opt}
							<option value={opt.value} selected={data.user.clan_allegiance === opt.value}>
								{opt.label}
							</option>
						{/each}
					</select>
				</label>

				<button type="submit" class="primary">Save</button>
			</form>

			<form method="POST" action="/auth/logout" class="logout">
				<button type="submit">Sign out</button>
			</form>
		</div>
	{:else if tab === 'packs'}
		<div class="panel">
			{#if data.packs.length === 0}
				<div class="empty">
					<p>No packs yet.</p>
					<p class="muted">Buy a pack to add one to your stash.</p>
				</div>
			{:else}
				<div class="card-grid">
					{#each data.packs as pack (pack.id)}
						<PackThumb {pack} quantity={pack.quantity} />
					{/each}
				</div>
			{/if}
		</div>
	{:else if tab === 'collection'}
		<div class="panel">
			{#if data.collection.length === 0}
				<div class="empty">
					<p>No cards yet.</p>
					<p class="muted">Open a pack to start collecting.</p>
				</div>
			{:else}
				<div class="card-grid">
					{#each data.collection as card (card.id)}
						<CardThumb {card} quantity={card.quantity} />
					{/each}
				</div>
			{/if}
		</div>
	{:else if tab === 'wallet'}
		<div class="panel">
			{#if data.wallet.length === 0}
				<div class="empty">
					<p>Your wallet is empty.</p>
					<p class="muted">Items you win from gamble boxes show up here.</p>
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

	.tabs {
		display: flex;
		gap: 0.25rem;
		margin: 1.25rem 0 1rem;
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

	form.edit {
		display: flex;
		flex-direction: column;
		gap: 1rem;
		max-width: 32rem;
	}

	form.logout {
		margin-top: 1.5rem;
		padding-top: 1.5rem;
		border-top: 1px solid var(--border);
		max-width: 32rem;
	}

	label {
		display: flex;
		flex-direction: column;
		gap: 0.35rem;
	}

	label span {
		font-size: 0.85rem;
		color: var(--muted);
	}

	.error {
		background: var(--danger-bg);
		border: 1px solid var(--danger);
		color: var(--danger);
		padding: 0.6rem 0.8rem;
		border-radius: 4px;
		margin-bottom: 1rem;
		max-width: 32rem;
	}

	.success {
		background: var(--success-bg);
		border: 1px solid var(--success);
		color: var(--success);
		padding: 0.6rem 0.8rem;
		border-radius: 4px;
		margin-bottom: 1rem;
		max-width: 32rem;
	}

	button.primary {
		border-color: var(--accent);
		font-family: 'rsbold', ui-sans-serif, Arial, sans-serif;
		align-self: flex-start;
	}

	button.primary:hover {
		background: var(--accent-soft);
	}

	.account-picker {
		border: none;
		padding: 0;
		margin: 0;
	}

	.account-picker legend {
		font-size: 0.85rem;
		color: var(--muted);
		padding: 0;
		margin-bottom: 0.45rem;
	}

	.account-options {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
	}

	.account-option {
		display: block;
		gap: 0;
		cursor: pointer;
	}

	.account-option input {
		position: absolute;
		opacity: 0;
		width: 0;
		height: 0;
		pointer-events: none;
	}

	.opt-card {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 56px;
		height: 56px;
		background: var(--surface-alt);
		border: 1px solid var(--border);
		border-radius: var(--radius);
		text-shadow: var(--ts);
		transition: border-color 0.15s, background 0.15s, box-shadow 0.15s;
	}

	.account-option:hover .opt-card {
		border-color: var(--border-strong);
	}

	.account-option input:checked + .opt-card {
		border-color: var(--accent);
		background: var(--accent-soft);
		box-shadow: inset 0 0 0 1px rgba(255, 152, 31, 0.3);
	}

	.account-option input:focus-visible + .opt-card {
		box-shadow: 0 0 0 3px rgba(255, 152, 31, 0.3);
	}

	.opt-icon {
		width: 30px;
		height: 30px;
		image-rendering: pixelated;
		image-rendering: crisp-edges;
		object-fit: contain;
	}

	.card-grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(9rem, 1fr));
		gap: 1rem;
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
