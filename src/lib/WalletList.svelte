<script lang="ts">
	import ItemIcon from '$lib/ItemIcon.svelte';
	import { formatGP } from '$lib/gp';

	// Shared unpaid-wallet item list (icon + name + optional GP value + ×qty), used by
	// both the profile Wallet tab and the public /u/[rsn] profile so they render the
	// same way (and both finally show item icons). Value column shows only when an
	// item carries a positive `value`.
	type WalletEntry = { name: string; quantity: number; unitPrice?: number; value?: number };
	let { items }: { items: WalletEntry[] } = $props();
</script>

<ul class="wallet-list">
	{#each items as item}
		<li>
			<span class="item-name"><ItemIcon item={item.name} /> {item.name}</span>
			<span class="item-meta">
				{#if (item.value ?? 0) > 0}<span class="item-val">{formatGP(item.value ?? 0)}</span>{/if}
				<span class="item-qty">×{item.quantity}</span>
			</span>
		</li>
	{/each}
</ul>

<style>
	.wallet-list {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 0.3rem;
	}
	.wallet-list li {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.75rem;
		padding: 0.4rem 0.6rem;
		background: rgba(0, 0, 0, 0.2);
		border: 1px solid var(--border);
		border-radius: 3px;
	}
	.item-name {
		display: inline-flex;
		align-items: center;
		gap: 0.45rem;
	}
	.item-meta {
		display: inline-flex;
		align-items: center;
		gap: 0.75rem;
		white-space: nowrap;
	}
	.item-val {
		color: var(--yellow);
		font-family: var(--font-heading);
	}
	.item-qty {
		color: var(--muted);
	}
</style>
