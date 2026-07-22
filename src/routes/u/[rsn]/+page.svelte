<script lang="ts">
	import type { PageData, ActionData } from './$types';
	import { enhance } from '$app/forms';
	import CardInspector3D from '$lib/cards/CardInspector3D.svelte';
	import type { UserCard } from '$lib/cards/rarity';
	import { CLAN_LABEL } from '$lib/clans';
	import type { ClanValue } from '$lib/clans';
	import { rankColor } from '$lib/ranks';
	import WalletList from '$lib/WalletList.svelte';
	import ProfileBanner from '$lib/profile/ProfileBanner.svelte';
	import ProfileTabs from '$lib/profile/ProfileTabs.svelte';
	import ProfilePanel from '$lib/profile/ProfilePanel.svelte';
	import RankPanel from '$lib/profile/RankPanel.svelte';
	import CollectionPanel from '$lib/profile/CollectionPanel.svelte';
	import StatsPanel from '$lib/profile/StatsPanel.svelte';
	import EmptyState from '$lib/profile/EmptyState.svelte';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	type Tab = 'rank' | 'collection' | 'stats' | 'wallet';
	let tab = $state<Tab>('rank');

	let rechecking = $state(false);

	// Collection card the viewer modal is showing (null = closed).
	let viewing = $state<UserCard | null>(null);

	let displayName = $derived(data.profileUser.rsn || data.profileUser.discord_username);
	let clanLabel = $derived(
		data.profileUser.clan_allegiance
			? CLAN_LABEL[data.profileUser.clan_allegiance as ClanValue]
			: null
	);
	let walletTotal = $derived(data.wallet.reduce((sum, w) => sum + w.quantity, 0));
	let packTotal = $derived(data.packs.reduce((sum, p) => sum + p.quantity, 0));

	let tabs = $derived([
		{ id: 'rank', label: 'Rank' },
		{ id: 'collection', label: 'Collection', count: data.collectionOwned },
		{ id: 'stats', label: 'Stats' },
		{ id: 'wallet', label: 'Wallet', count: walletTotal }
	]);
</script>

<svelte:head>
	<title>{displayName} · Volition</title>
</svelte:head>

<section class="profile">
	<ProfileBanner
		accountType={data.profileUser.account_type}
		name={displayName}
		username={data.profileUser.discord_username}
		{clanLabel}
		vp={data.vp_balance}
	/>

	{#if data.isSelf}
		<p class="self-note muted">This is your public profile. <a href="/me">Edit your profile →</a></p>
	{/if}

	<ProfileTabs {tabs} active={tab} onselect={(id) => (tab = id as Tab)} />

	{#if tab === 'rank'}
		<ProfilePanel>
			{#if data.canRecheck}
				<div class="admin-recheck">
					<form
						method="POST"
						action="?/recheck"
						use:enhance={() => {
							rechecking = true;
							return async ({ update }) => {
								await update({ reset: false });
								rechecking = false;
							};
						}}
					>
						<button class="btn" type="submit" disabled={rechecking}>
							{rechecking ? 'Re-checking…' : 'Re-check rank'}
						</button>
					</form>
					{#if form && 'recheckOk' in form && form.recheckOk}
						<span class="recheck-msg ok">
							Updated: <strong style="color:{rankColor(form.recheckRank)}">{form.recheckRank}</strong>
							{#if form.recheckRankedUp && form.recheckPrevRank}(up from {form.recheckPrevRank}){/if}
							{#if !form.recheckSaved && form.recheckNote}— {form.recheckNote}{/if}
						</span>
					{:else if form && 'recheckError' in form && form.recheckError}
						<span class="recheck-msg err">{form.recheckError}</span>
					{/if}
				</div>
			{/if}
			<RankPanel
				rank={data.rankBreakdown}
				currentRank={data.currentRank}
				emptyText="{displayName} hasn't checked their rank yet."
			/>
		</ProfilePanel>
	{:else if tab === 'collection'}
		<ProfilePanel>
			<CollectionPanel
				packs={data.packs}
				collection={data.collection}
				collectionOwned={data.collectionOwned}
				collectionTotal={data.collectionTotal}
				emptyTitle="Nothing to show yet."
				onview={(card) => (viewing = card)}
			/>
		</ProfilePanel>
	{:else if tab === 'stats'}
		<ProfilePanel>
			<StatsPanel
				vp={data.vp_balance}
				cards={data.stats}
				crateStats={data.crateStats}
				collectionOwned={data.collectionOwned}
				collectionTotal={data.collectionTotal}
				{packTotal}
				{walletTotal}
			/>
		</ProfilePanel>
	{:else if tab === 'wallet'}
		<ProfilePanel>
			{#if data.wallet.length === 0}
				<EmptyState title="Wallet is empty." />
			{:else}
				<WalletList items={data.wallet} />
			{/if}
		</ProfilePanel>
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

	.self-note {
		margin: 0.75rem 0 0;
		font-size: 0.85rem;
	}

	.muted {
		color: var(--muted);
	}

	.admin-recheck {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.6rem;
		margin-bottom: 0.9rem;
	}
	.recheck-msg {
		font-size: 0.85rem;
	}
	.recheck-msg.ok {
		color: var(--success, #6aa84f);
	}
	.recheck-msg.err {
		color: var(--danger);
	}
</style>
