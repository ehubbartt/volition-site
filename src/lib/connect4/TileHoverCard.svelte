<script lang="ts">
	// The card shown when you point at a Connect Four objective or a placed piece — the
	// same card for the flat board and the 3D one, so the two views never say different
	// things about the same tile.
	//
	// It carries the wiki links, which means it has to survive the pointer LEAVING the tile
	// and entering the card. The parent hides it on a short delay and `onkeep` cancels that,
	// the standard hover-card dance; without it the links are visible but unclickable.
	import WikiImage from '$lib/WikiImage.svelte';
	import { itemImageUrl, monsterImageUrl, wikiPageUrl } from '$lib/wikiImage';
	import { formatEhb } from '$lib/ehb';

	export interface CardInfo {
		/** `tile` = still on offer above a column; `piece` = already claimed. */
		kind: 'tile' | 'piece';
		itemName: string;
		source?: string | null;
		ehb?: number | null;
		/** Where it is, e.g. "M" for a column or "M4" for a cell. */
		where?: string | null;
		sideName?: string | null;
		sideColor?: string | null;
		byRsn?: string | null;
		via?: string | null;
		x: number;
		y: number;
	}

	let {
		info,
		onkeep,
		onrelease
	}: { info: CardInfo; onkeep?: () => void; onrelease?: () => void } = $props();
</script>

<div
	class="hovercard"
	style="left: {info.x}px; top: {info.y}px; --c: {info.sideColor ?? 'var(--accent)'}"
	role="tooltip"
	onpointerenter={() => onkeep?.()}
	onpointerleave={() => onrelease?.()}
>
	<div class="hc-head">
		<WikiImage src={itemImageUrl(info.itemName)} alt="" size={34} />
		<div class="hc-name">
			<strong>{info.itemName}</strong>
			<span class="hc-sub">
				{#if info.where}{info.where}{/if}
				{#if info.kind === 'piece' && info.sideName}· {info.sideName}
				{:else if info.kind === 'tile'}· still up for grabs{/if}
			</span>
		</div>
	</div>

	<div class="hc-meta">
		{#if info.source}
			<div class="hc-row">
				<WikiImage src={monsterImageUrl(info.source)} alt="" size={16} />
				<span>from <strong>{info.source}</strong></span>
			</div>
		{/if}
		{#if info.ehb}<div class="hc-row">{formatEhb(info.ehb)} to obtain</div>{/if}
		{#if info.byRsn}<div class="hc-row">by <strong>{info.byRsn}</strong></div>{/if}
		{#if info.via}<div class="hc-via">{info.via}</div>{/if}
	</div>

	<div class="hc-links">
		<a href={wikiPageUrl(info.itemName)} target="_blank" rel="noreferrer noopener">
			{info.itemName} wiki ↗
		</a>
		{#if info.source}
			<a href={wikiPageUrl(info.source)} target="_blank" rel="noreferrer noopener">
				{info.source} wiki ↗
			</a>
		{/if}
	</div>
</div>

<style>
	.hovercard {
		position: fixed;
		z-index: 50;
		transform: translate(-50%, calc(-100% - 10px));
		pointer-events: auto;
		min-width: 13rem;
		max-width: 19rem;
		padding: 0.5rem 0.6rem;
		background: var(--surface);
		border: 1px solid var(--border-strong);
		border-radius: var(--radius);
		box-shadow: var(--shadow-card);
	}
	/* The card floats 10px clear of the tile, and crossing that gap counts as leaving —
	   which made the wiki links visible but unreachable. This bridges it. */
	.hovercard::after {
		content: '';
		position: absolute;
		left: 0;
		right: 0;
		bottom: -14px;
		height: 14px;
	}
	.hc-head {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		border-left: 3px solid var(--c);
		padding-left: 0.4rem;
	}
	.hc-name {
		display: grid;
		min-width: 0;
	}
	.hc-name strong {
		color: var(--heading);
		font-size: 0.9rem;
		line-height: 1.2;
	}
	.hc-sub,
	.hc-meta {
		font-size: 0.75rem;
		color: var(--muted);
	}
	.hc-meta {
		margin-top: 0.35rem;
		display: grid;
		gap: 0.15rem;
	}
	.hc-row {
		display: flex;
		align-items: center;
		gap: 0.3rem;
	}
	.hc-via {
		opacity: 0.75;
		font-style: italic;
	}
	.hc-links {
		margin-top: 0.4rem;
		padding-top: 0.35rem;
		border-top: 1px solid var(--border);
		display: grid;
		gap: 0.15rem;
		font-size: 0.75rem;
	}
	.hc-links a {
		color: var(--accent);
		text-decoration: none;
	}
	.hc-links a:hover {
		text-decoration: underline;
	}
</style>
