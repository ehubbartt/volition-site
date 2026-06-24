<script lang="ts">
	import { rankImg, rankColor, rankLabel } from '$lib/ranks';

	// Rank badge: the rank's art if it has any, otherwise a colour dot — plus an
	// optional coloured label. Shared by the home dashboard and the profile Rank tab,
	// which each hand-rolled the same image-or-dot branch.
	let {
		rank,
		showLabel = false,
		size = 24
	}: {
		rank: string | null | undefined;
		showLabel?: boolean;
		size?: number;
	} = $props();

	let img = $derived(rankImg(rank));
	let color = $derived(rankColor(rank));
	let label = $derived(rankLabel(rank));
</script>

<span class="rank-badge">
	{#if img}
		<img src={img} alt={label} title={label} width={size} height={size} />
	{:else}
		<span class="dot" style="background:{color}; width:{size * 0.5}px; height:{size * 0.5}px" title={label}></span>
	{/if}
	{#if showLabel}<strong class="label" style="color:{color}">{label}</strong>{/if}
</span>

<style>
	.rank-badge {
		display: inline-flex;
		align-items: center;
		gap: 0.4rem;
	}
	.rank-badge img {
		object-fit: contain;
		image-rendering: -webkit-optimize-contrast;
	}
	.dot {
		display: inline-block;
		border-radius: 999px;
		box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.4);
	}
	.label {
		font-family: var(--font-heading);
		text-shadow: var(--ts);
	}
</style>
