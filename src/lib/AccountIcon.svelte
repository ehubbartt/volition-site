<script lang="ts">
	import { ACCOUNT_TYPE_ICON, ACCOUNT_TYPE_LABEL, type AccountType } from './accountTypes';

	let { type, size = 16 }: { type: string | null | undefined; size?: number } = $props();

	let icon = $derived(type ? (ACCOUNT_TYPE_ICON[type as AccountType] ?? null) : null);
	let label = $derived(type ? (ACCOUNT_TYPE_LABEL[type as AccountType] ?? '') : '');
</script>

{#if icon}
	<img
		src={icon}
		alt={label}
		title={label}
		class="account-icon"
		style="--size: {size}px"
		loading="lazy"
	/>
{/if}

<style>
	.account-icon {
		width: var(--size);
		height: var(--size);
		image-rendering: pixelated;
		image-rendering: crisp-edges;
		object-fit: contain;
		vertical-align: -2px;
		display: inline-block;
		flex-shrink: 0;
	}
</style>
