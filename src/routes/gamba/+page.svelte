<script lang="ts">
	import type { PageData } from './$types';
	import { enhance } from '$app/forms';
	import type { SubmitFunction } from '@sveltejs/kit';
	import PackOpener from '$lib/cards/PackOpener.svelte';
	import { DEFAULT_PACK_FRONT } from '$lib/cards/packs';
	import { RARITY_BY_KEY, DEFAULT_CARD_BACK, type Card } from '$lib/cards/rarity';
	import { rsnToSlug } from '$lib/rsn';

	let { data }: { data: PageData } = $props();

	function timeAgo(iso: string): string {
		const s = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
		if (s < 60) return 'just now';
		const m = Math.floor(s / 60);
		if (m < 60) return `${m}m ago`;
		const h = Math.floor(m / 60);
		if (h < 24) return `${h}h ago`;
		return `${Math.floor(h / 24)}d ago`;
	}

	function finishLabel(finish: string): string {
		return finish === 'holo' ? 'Holo' : finish === 'reverse' ? 'Reverse' : '';
	}

	let openerOpen = $state(false);
	let opened = $state<Card[]>([]);
	let openedPack = $state<{ name: string; front_url: string | null; back_url: string | null } | null>(
		null
	);
	let opening = $state<string | null>(null); // id of the pack currently opening
	let errorMsg = $state<string | null>(null);

	function canOpen(pack: PageData['packs'][number]): boolean {
		return opening === null && pack.card_count > 0 && data.vp_balance >= pack.cost_vp;
	}

	const submitOpen: SubmitFunction = ({ formData }) => {
		opening = formData.get('pack_id')?.toString() ?? null;
		errorMsg = null;
		return async ({ result, update }) => {
			if (result.type === 'success' && result.data?.ok) {
				opened = result.data.opened as Card[];
				openedPack = result.data.pack as typeof openedPack;
				openerOpen = true;
			} else if (result.type === 'failure') {
				errorMsg = (result.data?.error as string) ?? 'Could not open that pack.';
			} else if (result.type === 'error') {
				errorMsg = 'Something went wrong opening that pack.';
			}
			opening = null;
			// Refresh VP balance (and pack list) from the server without resetting UI.
			await update({ reset: false });
		};
	};
</script>

<svelte:head>
	<title>Gamba · Volition</title>
</svelte:head>

<section>
	<header class="head">
		<div>
			<h1>Gamba</h1>
			<p class="muted">Spend VP to rip open a pack. Cards you pull are added to your collection.</p>
		</div>
		<div class="vp" title="Volition Points">
			<span class="vp-amount">{data.vp_balance.toLocaleString()}</span>
			<span class="vp-label">VP</span>
		</div>
	</header>

	{#if errorMsg}
		<div class="error">{errorMsg}</div>
	{/if}

	{#if data.packs.length === 0}
		<div class="empty">
			<p>No packs are available right now.</p>
			<p class="muted">Check back soon.</p>
		</div>
	{:else}
		<div class="pack-grid">
			{#each data.packs as pack (pack.id)}
				{@const affordable = data.vp_balance >= pack.cost_vp}
				<article class="pack" class:dim={!affordable || pack.card_count === 0}>
					<img class="art" src={pack.front_url || DEFAULT_PACK_FRONT} alt={pack.name} />
					<div class="body">
						<strong class="name">{pack.name}</strong>
						{#if pack.description}
							<p class="desc muted">{pack.description}</p>
						{/if}
						<span class="muted small">
							{pack.card_count} card{pack.card_count === 1 ? '' : 's'} in set · {pack.cards_per_pack} per
							open
						</span>

						<form method="POST" action="?/open" use:enhance={submitOpen} class="open-form">
							<input type="hidden" name="pack_id" value={pack.id} />
							<button type="submit" class="primary" disabled={!canOpen(pack)}>
								{#if opening === pack.id}
									Opening…
								{:else if pack.card_count === 0}
									No cards yet
								{:else}
									Open · {pack.cost_vp.toLocaleString()} VP
								{/if}
							</button>
						</form>

						{#if !affordable && pack.card_count > 0}
							<span class="warn small">Not enough VP</span>
						{/if}
					</div>
				</article>
			{/each}
		</div>
	{/if}

	{#if data.recentRares.length > 0}
		<div class="rares">
			<h2>Recently opened rares</h2>
			<div class="rare-strip">
				{#each data.recentRares as pull (pull.id)}
					{@const meta = RARITY_BY_KEY[pull.rarity]}
					<article class="rare" style="--rare-color:{meta.color}">
						<div class="rare-art">
							<img src={pull.frontUrl || DEFAULT_CARD_BACK} alt={pull.cardName} />
							{#if finishLabel(pull.finish)}
								<span class="finish">{finishLabel(pull.finish)}</span>
							{/if}
						</div>
						<div class="rare-info">
							<strong class="rare-name" title={pull.cardName}>{pull.cardName}</strong>
							<span class="rare-rarity" style="color:{meta.color}">{meta.label}</span>
							{#if pull.packName}
								<span class="rare-pack muted" title={pull.packName}>from {pull.packName}</span>
							{/if}
							<span class="rare-by muted">
								{#if pull.rsn}
									<a href="/u/{rsnToSlug(pull.rsn)}">{pull.by}</a>
								{:else}
									{pull.by}
								{/if}
								· {timeAgo(pull.pulledAt)}
							</span>
						</div>
					</article>
				{/each}
			</div>
		</div>
	{/if}
</section>

{#if openerOpen && openedPack}
	<PackOpener pack={openedPack} cards={opened} onClose={() => (openerOpen = false)} />
{/if}

<style>
	.head {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 1rem;
		flex-wrap: wrap;
		margin-bottom: 1.5rem;
	}

	h1 {
		margin: 0 0 0.25rem;
	}

	.muted {
		color: var(--muted);
	}

	.small {
		font-size: 0.8rem;
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
		flex: 0 0 auto;
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

	.error {
		background: var(--danger-bg);
		border: 1px solid var(--danger);
		color: var(--danger);
		padding: 0.6rem 0.8rem;
		border-radius: 4px;
		margin-bottom: 1rem;
	}

	.empty {
		padding: 3rem 1rem;
		text-align: center;
	}

	.empty p {
		margin: 0.25rem 0;
	}

	.pack-grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(14rem, 1fr));
		gap: 1.25rem;
	}

	.pack {
		display: flex;
		flex-direction: column;
		background: linear-gradient(180deg, rgba(58, 48, 36, 0.85), rgba(40, 32, 24, 0.85));
		border: 1px solid var(--border);
		border-radius: var(--radius);
		box-shadow: var(--shadow-card);
		overflow: hidden;
		transition: border-color 0.15s, transform 0.15s;
	}

	.pack:hover {
		border-color: var(--accent);
		transform: translateY(-2px);
	}

	.pack.dim {
		opacity: 0.65;
	}

	.pack.dim:hover {
		transform: none;
		border-color: var(--border);
	}

	.art {
		width: 100%;
		aspect-ratio: 5 / 7;
		object-fit: cover;
		background: #0008;
		border-bottom: 1px solid var(--border);
	}

	.body {
		display: flex;
		flex-direction: column;
		gap: 0.4rem;
		padding: 0.85rem;
		flex: 1;
	}

	.name {
		font-size: 1.1rem;
	}

	.desc {
		margin: 0;
		font-size: 0.85rem;
		line-height: 1.35;
	}

	.open-form {
		margin-top: auto;
		padding-top: 0.5rem;
	}

	button.primary {
		width: 100%;
		border-color: var(--accent);
		font-family: 'rsbold', ui-sans-serif, Arial, sans-serif;
	}

	button.primary:hover:not(:disabled) {
		background: var(--accent-soft);
	}

	button.primary:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	.warn {
		color: var(--danger);
		text-align: center;
	}

	.rares {
		margin-top: 2.5rem;
		padding-top: 1.5rem;
		border-top: 1px solid var(--border);
	}

	.rares h2 {
		margin: 0 0 1rem;
		font-size: 1.2rem;
		color: var(--accent);
		text-shadow: var(--ts);
	}

	.rare-strip {
		display: flex;
		gap: 0.85rem;
		overflow-x: auto;
		padding-bottom: 0.75rem;
		scroll-snap-type: x proximity;
	}

	.rare {
		flex: 0 0 9.5rem;
		display: flex;
		flex-direction: column;
		background: var(--surface-alt);
		border: 1px solid var(--rare-color);
		border-radius: var(--radius);
		overflow: hidden;
		scroll-snap-align: start;
		box-shadow: 0 0 0.5rem -0.1rem var(--rare-color);
	}

	.rare-art {
		position: relative;
		width: 100%;
		aspect-ratio: 5 / 7;
		background: #0008;
	}

	.rare-art img {
		width: 100%;
		height: 100%;
		object-fit: cover;
	}

	.finish {
		position: absolute;
		top: 0.35rem;
		right: 0.35rem;
		padding: 0.05rem 0.4rem;
		background: rgba(0, 0, 0, 0.7);
		border: 1px solid var(--rare-color);
		border-radius: 999px;
		font-size: 0.65rem;
		color: var(--rare-color);
	}

	.rare-info {
		display: flex;
		flex-direction: column;
		gap: 0.15rem;
		padding: 0.5rem 0.6rem 0.6rem;
	}

	.rare-name {
		font-size: 0.9rem;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.rare-rarity {
		font-size: 0.75rem;
		font-family: 'rsbold', ui-sans-serif, Arial, sans-serif;
	}

	.rare-pack {
		font-size: 0.72rem;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.rare-by {
		font-size: 0.72rem;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	/* On phones the single full-width column made each pack (and its button) fill
	   the screen — drop to a compact 2-up grid. */
	@media (max-width: 540px) {
		.pack-grid {
			grid-template-columns: repeat(2, 1fr);
			gap: 0.75rem;
		}

		.body {
			padding: 0.6rem;
			gap: 0.3rem;
		}

		.name {
			font-size: 0.95rem;
		}

		button.primary {
			font-size: 0.85rem;
			padding: 0.5rem 0.35rem;
		}
	}
</style>
