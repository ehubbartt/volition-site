<script lang="ts">
	import type { PageData, ActionData } from './$types';
	import AccountIcon from '$lib/AccountIcon.svelte';
	import CardThumb from '$lib/cards/CardThumb.svelte';
	import PackThumb from '$lib/cards/PackThumb.svelte';
	import CardInspector3D from '$lib/cards/CardInspector3D.svelte';
	import type { UserCard } from '$lib/cards/rarity';
	import { FINISH_BY_KEY } from '$lib/cards/finishes';
	import { CLAN_LABEL } from '$lib/clans';
	import type { ClanValue } from '$lib/clans';
	import { rsnToSlug } from '$lib/rsn';
	import { formatGP } from '$lib/gp';
	import { enhance } from '$app/forms';
	import { invalidateAll } from '$app/navigation';
	import { page } from '$app/stores';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	// Wallet → GP conversion (posts to the gamba action; reloads /me on success).
	let walletConverting = $state(false);
	let walletMsg = $state<string | null>(null);

	type Tab = 'profile' | 'collection' | 'stats' | 'wallet';
	// Initial tab can be deep-linked via ?tab= (e.g. /me?tab=collection from the gamba page).
	const TABS: Tab[] = ['profile', 'collection', 'stats', 'wallet'];
	const requestedTab = $page.url.searchParams.get('tab') as Tab | null;
	let tab = $state<Tab>(requestedTab && TABS.includes(requestedTab) ? requestedTab : 'profile');

	// Collection card the viewer modal is showing (null = closed).
	let viewing = $state<UserCard | null>(null);

	let tabs = $derived<{ id: Tab; label: string }[]>([
		{ id: 'profile', label: 'Profile' },
		{ id: 'collection', label: 'Collection' },
		{ id: 'stats', label: 'Stats' },
		{ id: 'wallet', label: 'Wallet' }
	]);

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

	{#if data.user.rsn}
		<p class="profile-link muted">
			<a href="/u/{rsnToSlug(data.user.rsn)}">View your public profile →</a>
		</p>
	{/if}

	<nav class="tabs">
		{#each tabs as t}
			<button
				type="button"
				class="tab"
				class:active={tab === t.id}
				onclick={() => (tab = t.id)}
			>
				{t.label}
				{#if t.id === 'collection' && data.collectionOwned}
					<span class="count">{data.collectionOwned}</span>
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
	{:else if tab === 'collection'}
		<div class="panel">
			{#if data.collection.length === 0 && data.packs.length === 0}
				<div class="empty">
					<p>Nothing here yet.</p>
					<p class="muted">Open a pack to start collecting.</p>
				</div>
			{:else}
				{#if data.packs.length > 0}
					<h3 class="section-head">Unopened packs <span class="count">{packTotal}</span></h3>
					<div class="card-grid packs-grid">
						{#each data.packs as pack (pack.id)}
							<PackThumb {pack} quantity={pack.quantity} />
						{/each}
					</div>
				{/if}

				<h3 class="section-head">
					Cards <span class="count-text muted">{data.collectionOwned} / {data.collectionTotal} collected</span>
				</h3>
				{#if data.collection.length === 0}
					<p class="muted">No cards yet — open a pack to start collecting.</p>
				{:else}
					<div class="card-grid">
						{#each data.collection as card (card.id + '-' + card.finish)}
							{#if card.owned}
								<button type="button" class="thumb-btn" onclick={() => (viewing = card)}>
									<CardThumb {card} quantity={card.quantity} finish={card.finish} flip={false} />
								</button>
							{:else if card.hidden}
								<div class="thumb-btn mystery-slot" title="Secret rare — undiscovered">
									<CardThumb {card} flip={false} />
								</div>
							{:else}
								<div class="thumb-btn locked" title="Not owned · {FINISH_BY_KEY[card.finish]?.label ?? 'Normal'}">
									<CardThumb {card} finish={card.finish} backOnly flip={false} />
								</div>
							{/if}
						{/each}
					</div>
				{/if}
			{/if}
		</div>
	{:else if tab === 'stats'}
		<div class="panel">
			<div class="stats-grid">
				<section class="stat-card">
					<h3>Volition Points</h3>
					<div class="mini-stats">
						<div class="ms"><span class="ms-num">{data.vp_balance.toLocaleString()}</span><span class="ms-lbl">Current VP</span></div>
					</div>
				</section>

				<section class="stat-card">
					<h3>Cards</h3>
					<div class="mini-stats">
						<div class="ms"><span class="ms-num">{data.myStats.cardsOwned}</span><span class="ms-lbl">Cards owned</span></div>
						<div class="ms"><span class="ms-num">{data.collectionOwned} / {data.collectionTotal}</span><span class="ms-lbl">Variants collected</span></div>
					</div>
				</section>

				<section class="stat-card">
					<h3>Packs</h3>
					<div class="mini-stats">
						<div class="ms"><span class="ms-num">{packTotal}</span><span class="ms-lbl">Unopened</span></div>
						<div class="ms"><span class="ms-num">{data.myStats.packsOpened}</span><span class="ms-lbl">Opened</span></div>
						<div class="ms"><span class="ms-num">{data.myStats.cardsPulled}</span><span class="ms-lbl">Cards pulled</span></div>
						<div class="ms"><span class="ms-num">{data.myStats.vpSpent.toLocaleString()}</span><span class="ms-lbl">VP spent</span></div>
					</div>
				</section>

				<section class="stat-card">
					<h3>Gamba crates</h3>
					<div class="mini-stats">
						<div class="ms"><span class="ms-num">{data.crateStats.totalOpens}</span><span class="ms-lbl">Opened</span></div>
						<div class="ms"><span class="ms-num">{data.crateStats.freeOpens}</span><span class="ms-lbl">Free</span></div>
						<div class="ms"><span class="ms-num">{data.crateStats.paidOpens}</span><span class="ms-lbl">Paid</span></div>
						<div class="ms"><span class="ms-num">{data.crateStats.vpWon.toLocaleString()}</span><span class="ms-lbl">VP won</span></div>
						<div class="ms"><span class="ms-num">{data.crateStats.vpSpent.toLocaleString()}</span><span class="ms-lbl">VP spent</span></div>
						<div class="ms"><span class="ms-num">{data.crateStats.biggestWin.toLocaleString()}</span><span class="ms-lbl">Biggest win</span></div>
					</div>
				</section>

				<section class="stat-card">
					<h3>Wallet</h3>
					<div class="mini-stats">
						<div class="ms"><span class="ms-num">{walletTotal}</span><span class="ms-lbl">Unpaid items</span></div>
					</div>
				</section>
			</div>
		</div>
	{:else if tab === 'wallet'}
		<div class="panel">
			{#if data.isAdmin}
			<div class="wallet-head">
				<div class="gp-bal" title="Your spendable wallet balance">
					<span class="gp-amount">{formatGP(data.gold_balance)}</span>
					<span class="gp-label">Wallet balance</span>
				</div>
				{#if data.walletGpValue > 0}
					<form
						method="POST"
						action="/gamba?/convertWallet"
						use:enhance={() => {
							walletConverting = true;
							walletMsg = null;
							return async ({ result }) => {
								walletConverting = false;
								if (result.type === 'success' && (result.data as { convertOk?: boolean })?.convertOk) {
									const g = Number((result.data as { gained?: number }).gained ?? 0);
									walletMsg = `Converted ${formatGP(g)} into your balance.`;
								} else if (result.type === 'failure') {
									walletMsg =
										((result.data as { convertError?: string })?.convertError) ??
										'Could not convert your wallet.';
								} else if (result.type === 'error') {
									walletMsg = 'Something went wrong converting your wallet.';
								}
								await invalidateAll();
							};
						}}
						onsubmit={(e) => {
							if (
								!confirm(
									`Convert all wallet items (${formatGP(data.walletGpValue)})? This settles those items — you won't be paid for them separately in-game.`
								)
							)
								e.preventDefault();
						}}
					>
						<button type="submit" class="convert-btn" disabled={walletConverting}>
							{walletConverting ? 'Converting…' : `Convert ${formatGP(data.walletGpValue)}`}
						</button>
					</form>
				{/if}
			</div>
			{#if walletMsg}<p class="wallet-msg">{walletMsg}</p>{/if}
			{/if}

			{#if data.wallet.length === 0}
				<div class="empty">
					<p>No unpaid items in your wallet.</p>
					<p class="muted">Items you win from gamble boxes show up here{#if data.isAdmin}. Convert them to buy packs, or cash them out in-game{:else}, paid out in-game{/if}.</p>
				</div>
			{:else}
				<ul class="wallet-list">
					{#each data.wallet as item}
						<li>
							<span class="item-name">{item.name}</span>
							<span class="item-meta">
								{#if data.isAdmin && item.unitPrice > 0}<span class="item-val">{formatGP(item.value)}</span>{/if}
								<span class="item-qty">×{item.quantity}</span>
							</span>
						</li>
					{/each}
				</ul>
				{#if data.isAdmin}
					<p class="muted small wallet-total">Wallet value: <strong>{formatGP(data.walletGpValue)}</strong></p>
				{/if}
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

	.profile-link {
		margin: 0.75rem 0 0;
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

	/* Unowned cards: greyed out, not interactive, with a lock badge. */
	.thumb-btn.locked {
		cursor: default;
	}

	/* Undiscovered secret rares: a mystery spot, not interactive. */
	.thumb-btn.mystery-slot {
		cursor: default;
	}

	.mini-stats {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(7rem, 1fr));
		gap: 0.75rem;
		margin: 0;
	}

	.section-head {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		margin: 1.5rem 0 0.75rem;
		font-size: 1.05rem;
	}

	.section-head:first-child {
		margin-top: 0;
	}

	.count-text {
		font-size: 0.8rem;
		font-weight: normal;
	}

	.packs-grid {
		margin-bottom: 0.5rem;
	}

	.stats-grid {
		display: flex;
		flex-direction: column;
		gap: 1.5rem;
	}

	.stat-card h3 {
		margin: 0 0 0.6rem;
		font-size: 1rem;
		color: var(--accent);
		text-shadow: var(--ts);
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

	.item-meta {
		display: flex;
		align-items: baseline;
		gap: 0.6rem;
	}
	.item-val {
		color: #e9c349;
		font-size: 0.9rem;
	}
	.item-qty {
		color: var(--muted);
	}

	.wallet-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
		flex-wrap: wrap;
		margin-bottom: 0.9rem;
	}
	.gp-bal {
		display: flex;
		align-items: baseline;
		gap: 0.4rem;
		padding: 0.45rem 0.9rem;
		background: rgba(255, 215, 0, 0.1);
		border: 1px solid #e9c349;
		border-radius: 999px;
	}
	.gp-amount {
		font-family: 'rsbold', ui-sans-serif, Arial, sans-serif;
		font-size: 1.4rem;
		color: #e9c349;
	}
	.gp-label {
		color: #e9c349;
		font-size: 0.8rem;
	}
	.convert-btn {
		border: 1px solid #e9c349;
		background: rgba(255, 215, 0, 0.1);
		color: #e9c349;
		padding: 0.5rem 0.9rem;
		border-radius: var(--radius);
		cursor: pointer;
	}
	.convert-btn:hover:not(:disabled) {
		background: rgba(255, 215, 0, 0.2);
	}
	.convert-btn:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}
	.wallet-msg {
		color: #7fd18a;
		margin: 0 0 0.8rem;
		font-size: 0.9rem;
	}
	.wallet-total {
		margin-top: 0.75rem;
		text-align: right;
	}

	@media (max-width: 480px) {
		h1 {
			font-size: 1.4rem;
		}
	}
</style>
