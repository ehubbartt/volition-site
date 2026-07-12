<script lang="ts">
	import CardThumb from '$lib/cards/CardThumb.svelte';
	import PackThumb from '$lib/cards/PackThumb.svelte';
	import type { UserCard } from '$lib/cards/rarity';
	import type { UserPack } from '$lib/cards/packs';
	import { FINISH_BY_KEY } from '$lib/cards/finishes';
	import EmptyState from './EmptyState.svelte';

	// Shared Collection tab body for /me and /u/[rsn]: unopened packs grid + the
	// full card grid (owned / locked / undiscovered-mystery slots). The card viewer
	// modal stays in the page — clicking an owned card calls `onview`.
	type CollectionEntry = UserCard & { owned: boolean; hidden?: boolean };

	let {
		packs,
		collection,
		collectionOwned,
		collectionTotal,
		onview,
		emptyTitle = 'Nothing here yet.',
		emptyHint = null,
		noCardsText = 'No cards yet.'
	}: {
		packs: UserPack[];
		collection: CollectionEntry[];
		collectionOwned: number;
		collectionTotal: number;
		onview: (card: UserCard) => void;
		emptyTitle?: string;
		emptyHint?: string | null;
		noCardsText?: string;
	} = $props();

	let packTotal = $derived(packs.reduce((sum, p) => sum + p.quantity, 0));
</script>

{#if collection.length === 0 && packs.length === 0}
	<EmptyState title={emptyTitle} hint={emptyHint} />
{:else}
	{#if packs.length > 0}
		<h3 class="section-head">Unopened packs <span class="count">{packTotal}</span></h3>
		<div class="card-grid packs-grid">
			{#each packs as pack (pack.id)}
				<PackThumb {pack} quantity={pack.quantity} />
			{/each}
		</div>
	{/if}

	<h3 class="section-head">
		Cards <span class="count-text muted">{collectionOwned} / {collectionTotal} collected</span>
	</h3>
	{#if collection.length === 0}
		<p class="muted">{noCardsText}</p>
	{:else}
		<div class="card-grid">
			{#each collection as card (card.id + '-' + card.finish)}
				{#if card.owned}
					<button type="button" class="thumb-btn" onclick={() => onview(card)}>
						<CardThumb {card} quantity={card.quantity} finish={card.finish} flip={false} />
					</button>
				{:else if card.hidden}
					<div class="thumb-btn mystery-slot" title="Secret rare — undiscovered">
						<CardThumb {card} flip={false} />
					</div>
				{:else}
					<div
						class="thumb-btn locked"
						title="Not owned · {FINISH_BY_KEY[card.finish]?.label ?? 'Normal'}"
					>
						<CardThumb {card} finish={card.finish} backOnly flip={false} />
					</div>
				{/if}
			{/each}
		</div>
	{/if}
{/if}

<style>
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

	.count {
		padding: 0.05rem 0.45rem;
		background: var(--surface-alt);
		border: 1px solid var(--border);
		border-radius: 3px;
		font-size: 0.75rem;
		color: var(--text);
	}

	.count-text {
		font-size: 0.8rem;
		font-weight: normal;
	}

	.card-grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(9rem, 1fr));
		gap: 1rem;
	}

	.packs-grid {
		margin-bottom: 0.5rem;
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

	/* Unowned cards: greyed out, not interactive. Undiscovered secret rares: a
	   mystery spot, not interactive. */
	.thumb-btn.locked,
	.thumb-btn.mystery-slot {
		cursor: default;
	}

	.muted {
		color: var(--muted);
	}
</style>
