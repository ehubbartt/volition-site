<script lang="ts">
	import type { PageData } from './$types';
	import CardInspector3D from '$lib/cards/CardInspector3D.svelte';
	import type { UserCard } from '$lib/cards/rarity';
	import { CLAN_LABEL } from '$lib/clans';
	import type { ClanValue } from '$lib/clans';
	import WalletList from '$lib/WalletList.svelte';
	import ProfileBanner from '$lib/profile/ProfileBanner.svelte';
	import ProfileTabs from '$lib/profile/ProfileTabs.svelte';
	import ProfilePanel from '$lib/profile/ProfilePanel.svelte';
	import RankPanel from '$lib/profile/RankPanel.svelte';
	import CollectionPanel from '$lib/profile/CollectionPanel.svelte';
	import StatsPanel from '$lib/profile/StatsPanel.svelte';
	import EmptyState from '$lib/profile/EmptyState.svelte';

	let { data }: { data: PageData } = $props();

	type Tab = 'rank' | 'collection' | 'stats' | 'wallet';
	let tab = $state<Tab>('rank');

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
</style>
