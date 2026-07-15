<script lang="ts">
	import type { Snippet } from 'svelte';
	import WikiImage from '$lib/WikiImage.svelte';
	import { wikiPageUrl } from '$lib/wikiImage';

	// Generic OSRS "thing info" modal: icon + heading, label/value rows, wiki links,
	// and page-specific extras via the children snippet. Extracted from the personal-
	// bingo tile modal so any page can show wiki info about an item the same way —
	// pass `rows` for simple facts, `wikiPages` for the ↗ links, and render richer
	// content (status lines, submit buttons) as children; those keep the caller's
	// scoped styles.
	let {
		name,
		image = null,
		rows = [],
		wikiPages = [],
		onclose,
		children
	}: {
		name: string;
		image?: string | null; // full image URL (itemImageUrl(...) / skillImageUrl(...))
		rows?: { label: string; value: string }[];
		wikiPages?: string[]; // wiki page names, rendered as "<page> wiki ↗" links
		onclose: () => void;
		children?: Snippet;
	} = $props();
</script>

<svelte:window onkeydown={(e) => { if (e.key === 'Escape') onclose(); }} />

<div
	class="modal-backdrop"
	role="presentation"
	onclick={(e) => {
		if (e.target === e.currentTarget) onclose();
	}}
>
	<div class="modal" role="dialog" tabindex="-1" aria-modal="true" aria-label={name}>
		<button class="modal-close" type="button" aria-label="Close" onclick={onclose}>×</button>
		<div class="modal-head">
			{#if image}
				<div class="modal-icon"><WikiImage src={image} size={48} /></div>
			{/if}
			<h3>{name}</h3>
		</div>

		{#if rows.length}
			<dl class="modal-dl">
				{#each rows as r (r.label)}
					<div><dt>{r.label}</dt><dd>{r.value}</dd></div>
				{/each}
			</dl>
		{/if}
		{#if wikiPages.length}
			<div class="modal-links">
				{#each wikiPages as p (p)}
					<a href={wikiPageUrl(p)} target="_blank" rel="noreferrer noopener">{p} wiki ↗</a>
				{/each}
			</div>
		{/if}

		{#if children}{@render children()}{/if}
	</div>
</div>

<style>
	.modal-backdrop {
		position: fixed;
		inset: 0;
		z-index: 50;
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 1rem;
		background: rgba(0, 0, 0, 0.6);
	}
	.modal {
		position: relative;
		width: 100%;
		max-width: 22rem;
		background: #2a2418;
		border: 4px solid transparent;
		border-image: url('/osrs/border-tiny.png') 4 / 4px round;
		border-radius: 6px;
		padding: 1.1rem 1.2rem 1.2rem;
	}
	.modal-close {
		position: absolute;
		top: 0.35rem;
		right: 0.5rem;
		background: none;
		border: none;
		min-height: 0;
		padding: 0.1rem 0.4rem;
		font-size: 1.3rem;
		line-height: 1;
		color: var(--muted);
		cursor: pointer;
	}
	.modal-close:hover {
		color: var(--accent);
	}
	.modal-head {
		display: flex;
		align-items: center;
		gap: 0.7rem;
		margin-bottom: 0.8rem;
	}
	.modal-icon {
		flex: none;
		display: flex;
		align-items: center;
		justify-content: center;
		width: 58px;
		height: 58px;
		border-radius: 50%;
		background: radial-gradient(circle at 50% 38%, #f1e8cf, #c3b088);
		box-shadow: inset 0 0 0 2px rgba(0, 0, 0, 0.45);
	}
	.modal-head h3 {
		margin: 0;
		font-size: 1.05rem;
		color: var(--accent);
	}
	.modal-dl {
		margin: 0 0 0.9rem;
		display: flex;
		flex-direction: column;
		gap: 0.3rem;
	}
	.modal-dl > div {
		display: flex;
		justify-content: space-between;
		gap: 1rem;
		font-size: 0.88rem;
	}
	.modal-dl dt {
		color: var(--muted);
	}
	.modal-links {
		display: flex;
		flex-wrap: wrap;
		gap: 0.4rem 1rem;
		margin-bottom: 0.4rem;
	}
	.modal-links a {
		font-size: 0.85rem;
	}
</style>
