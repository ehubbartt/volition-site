<script lang="ts">
	import type { PageData } from './$types';
	import { enhance } from '$app/forms';
	import type { SubmitFunction } from '@sveltejs/kit';
	import PackOpener from '$lib/cards/PackOpener.svelte';
	import CardThumb from '$lib/cards/CardThumb.svelte';
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

	function fullTime(iso: string): string {
		return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
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

	// Pack-contents modal (shows the cards in a set — no drop rates).
	let viewingPack = $state<{ name: string; cards: Card[] } | null>(null);

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

	// ---- Gamba crates ----
	type CrateReward = {
		kind: 'vp' | 'item' | 'role';
		amount: number;
		itemName: string | null;
		label: string;
		title: string;
		image: string;
		colorHex: string;
		chance: number;
		isFree: boolean;
	};

	type StoreView = 'packs' | 'crates';
	let view = $state<StoreView>('packs');
	let crateBusy = $state<null | 'free' | 'paid'>(null);
	let crateReward = $state<CrateReward | null>(null);
	let crateError = $state<string | null>(null);

	function pct(n: number): string {
		return n < 1 ? n.toFixed(2) : n.toFixed(1);
	}

	// Live countdown to the next free crate (resets at midnight UTC, matching the
	// bot's last_loot_date day boundary).
	let now = $state(Date.now());
	$effect(() => {
		const id = setInterval(() => (now = Date.now()), 1000);
		return () => clearInterval(id);
	});

	function msUntilNextUtcMidnight(fromMs: number): number {
		const d = new Date(fromMs);
		return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1) - fromMs;
	}

	function formatCountdown(ms: number): string {
		if (ms <= 0) return 'soon';
		const total = Math.floor(ms / 1000);
		const h = Math.floor(total / 3600);
		const m = Math.floor((total % 3600) / 60);
		const s = total % 60;
		if (h > 0) return `${h}h ${m}m`;
		if (m > 0) return `${m}m ${s}s`;
		return `${s}s`;
	}

	let freeCountdown = $derived(formatCountdown(msUntilNextUtcMidnight(now)));

	function submitCrate(which: 'free' | 'paid'): SubmitFunction {
		return () => {
			crateBusy = which;
			crateError = null;
			return async ({ result, update }) => {
				if (result.type === 'success' && result.data?.crateOk) {
					crateReward = result.data.reward as CrateReward;
				} else if (result.type === 'failure') {
					crateError = (result.data?.crateError as string) ?? 'Could not open the crate.';
				} else if (result.type === 'error') {
					crateError = 'Something went wrong opening the crate.';
				}
				crateBusy = null;
				// Refresh VP + free-claim availability without resetting the UI.
				await update({ reset: false });
			};
		};
	}
</script>

<svelte:head>
	<title>Gamba · Volition</title>
</svelte:head>

<section class="gamba">
	<header class="hero">
		<div class="hero-glow"></div>
		<div class="hero-text">
			<h1>Gamba</h1>
			<p>Spend VP to rip open a pack — every card you pull lands straight in your collection.</p>
		</div>
		<div class="vp" title="Volition Points">
			<span class="vp-amount">{data.vp_balance.toLocaleString()}</span>
			<span class="vp-label">VP</span>
		</div>
	</header>

	<div class="view-tabs">
		<button type="button" class:active={view === 'packs'} onclick={() => (view = 'packs')}>Packs</button>
		<button type="button" class:active={view === 'crates'} onclick={() => (view = 'crates')}>Crates</button>
	</div>

	{#if view === 'packs'}
	{#if errorMsg}
		<div class="error">{errorMsg}</div>
	{/if}

	<div class="store" class:no-rail={data.recentRares.length === 0}>
		<div class="main">
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
							<div class="pack-art">
								<img src={pack.front_url || DEFAULT_PACK_FRONT} alt={pack.name} />
								<span class="pack-tag">{pack.cards_per_pack} per open</span>
							</div>
							<div class="body">
								<strong class="name">{pack.name}</strong>
								{#if pack.description}
									<p class="desc muted">{pack.description}</p>
								{/if}
								<span class="muted small">{pack.card_count} card{pack.card_count === 1 ? '' : 's'} in set</span>

								{#if pack.cards.length > 0}
									<button
										type="button"
										class="view-cards"
										onclick={() => (viewingPack = { name: pack.name, cards: pack.cards })}
									>
										View cards
									</button>
								{/if}

								<form method="POST" action="?/open" use:enhance={submitOpen} class="open-form">
									<input type="hidden" name="pack_id" value={pack.id} />
									<button type="submit" class="primary" disabled={!canOpen(pack)}>
										{#if opening === pack.id}
											Opening…
										{:else if pack.card_count === 0}
											No cards yet
										{:else}
											Rip open · {pack.cost_vp.toLocaleString()} VP
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
		</div>

		{#if data.recentRares.length > 0}
			<aside class="rail">
				<h2 class="rail-title"><span class="live"></span> Live drops</h2>
				<div class="rail-list">
					{#each data.recentRares as pull (pull.id)}
						{@const meta = RARITY_BY_KEY[pull.rarity]}
						{@const fin = finishLabel(pull.finish)}
						<article class="drop" style="--rare-color:{meta.color}">
							<div class="drop-art">
								<img class="front" src={pull.frontUrl || DEFAULT_CARD_BACK} alt={pull.cardName} loading="lazy" />
								{#each pull.layers as ly}
									<img class="layer" src={ly.url} alt="" loading="lazy" />
								{/each}
							</div>
							<div class="drop-info">
								<strong class="drop-name" title={pull.cardName}>{pull.cardName}</strong>
								<span class="drop-rarity" style="color:{meta.color}">
									{meta.label}{#if fin} · {fin}{/if}
								</span>
								{#if pull.packName}
									<span class="drop-sub" title={pull.packName}>from {pull.packName}</span>
								{/if}
								<span class="drop-sub">
									by
									{#if pull.rsn}
										<a href="/u/{rsnToSlug(pull.rsn)}">{pull.by}</a>
									{:else}
										{pull.by}
									{/if}
								</span>
								<span class="drop-time" title={fullTime(pull.pulledAt)}>{timeAgo(pull.pulledAt)}</span>
							</div>
						</article>
					{/each}
				</div>
			</aside>
		{/if}
	</div>
	{:else}
	<div class="store" class:no-rail={data.recentCrateDrops.length === 0}>
		<div class="main">
		{#if crateError}
			<div class="error">{crateError}</div>
		{/if}

		<div class="crate-wrap">
			<article class="crate">
				<div class="crate-icon">📦</div>
				<div class="crate-body">
					<h2>Gamba Crate</h2>
					<p class="muted">Roll for VP, rare items, or glory — the same odds as the Discord crate.</p>
					<div class="crate-actions">
						<form method="POST" action="?/claimFreeCrate" use:enhance={submitCrate('free')}>
							<button type="submit" class="primary" disabled={!data.crate.freeAvailable || crateBusy !== null}>
								{#if crateBusy === 'free'}
									Opening…
								{:else if data.crate.freeAvailable}
									Free daily crate
								{:else}
									Claimed · {freeCountdown}
								{/if}
							</button>
						</form>
						<form method="POST" action="?/openCrate" use:enhance={submitCrate('paid')}>
							<button type="submit" class="primary" disabled={crateBusy !== null || data.vp_balance < data.crate.spinCost}>
								{#if crateBusy === 'paid'}
									Opening…
								{:else}
									Open · {data.crate.spinCost} VP
								{/if}
							</button>
						</form>
					</div>
					{#if !data.crate.freeAvailable}
						<span class="muted small">Daily crate already claimed — next free one in {freeCountdown} (resets midnight UTC).</span>
					{/if}
					{#if data.vp_balance < data.crate.spinCost}
						<span class="warn small">Not enough VP for a paid open</span>
					{/if}
				</div>
			</article>

			<details class="odds">
				<summary>Drop rates</summary>
				<ul>
					{#each data.crate.odds as o}
						<li>
							<span class="odds-label" style="color:{o.color}">{o.label}</span>
							<span class="muted">{pct(o.pct)}%</span>
						</li>
					{/each}
				</ul>
			</details>
		</div>
		</div>

		{#if data.recentCrateDrops.length > 0}
			<aside class="rail">
				<h2 class="rail-title"><span class="live"></span> Live drops</h2>
				<div class="rail-list">
					{#each data.recentCrateDrops as drop (drop.id)}
						<article class="drop" style="--rare-color:{drop.colorHex}">
							<div class="drop-art">
								{#if drop.image}
									<img class="front" src={drop.image} alt="" loading="lazy" />
								{:else}
									<div class="drop-noimg">{drop.kind === 'vp' ? 'VP' : '?'}</div>
								{/if}
							</div>
							<div class="drop-info">
								<strong class="drop-name" title={drop.label}>{drop.label}</strong>
								<span class="drop-sub">{drop.isFree ? 'free crate' : 'paid crate'}</span>
								<span class="drop-sub">
									by
									{#if drop.rsn}
										<a href="/u/{rsnToSlug(drop.rsn)}">{drop.by}</a>
									{:else}
										{drop.by}
									{/if}
								</span>
								<span class="drop-time" title={fullTime(drop.at)}>{timeAgo(drop.at)}</span>
							</div>
						</article>
					{/each}
				</div>
			</aside>
		{/if}
	</div>
	{/if}
</section>

{#if openerOpen && openedPack}
	<PackOpener pack={openedPack} cards={opened} onClose={() => (openerOpen = false)} />
{/if}

{#if crateReward}
	<div class="reveal-wrap">
		<button class="reveal-backdrop" aria-label="Close" onclick={() => (crateReward = null)}></button>
		<div class="reveal" role="dialog" aria-modal="true" tabindex="-1" style="--c:{crateReward.colorHex}">
			<div class="reveal-burst"></div>
			{#if crateReward.image}
				<img class="reveal-img" src={crateReward.image} alt="" />
			{/if}
			<h3 class="reveal-title">{crateReward.title}</h3>
			<p class="reveal-detail">
				{#if crateReward.kind === 'vp'}
					{crateReward.amount > 0 ? `+${crateReward.amount} VP` : 'Nothing this time'}
				{:else if crateReward.kind === 'item'}
					{crateReward.itemName}
				{:else}
					King Gamba — assigned in Discord shortly
				{/if}
			</p>
			<span class="reveal-chance">{crateReward.label} · {pct(crateReward.chance)}%</span>
			<button type="button" class="primary reveal-close" onclick={() => (crateReward = null)}>Nice</button>
		</div>
	</div>
{/if}

{#if viewingPack}
	<div class="contents-wrap">
		<button class="contents-backdrop" aria-label="Close" onclick={() => (viewingPack = null)}></button>
		<div class="contents" role="dialog" aria-modal="true" tabindex="-1">
			<header class="contents-head">
				<h3>{viewingPack.name} · {viewingPack.cards.length} cards</h3>
				<button type="button" class="contents-close" aria-label="Close" onclick={() => (viewingPack = null)}>✕</button>
			</header>
			<div class="contents-grid">
				{#each viewingPack.cards as card (card.id)}
					<CardThumb {card} flip={true} />
				{/each}
			</div>
		</div>
	</div>
{/if}

<style>
	.gamba {
		max-width: 1100px;
		margin: 0 auto;
	}

	.muted {
		color: var(--muted);
	}

	.small {
		font-size: 0.8rem;
	}

	/* ---- Hero ---- */
	.hero {
		position: relative;
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
		flex-wrap: wrap;
		padding: 1.6rem 1.75rem;
		margin-bottom: 1.5rem;
		background: linear-gradient(135deg, rgba(70, 54, 30, 0.95), rgba(34, 27, 20, 0.95));
		border: 1px solid var(--border-strong);
		border-radius: var(--radius-lg);
		box-shadow: var(--shadow-card);
		overflow: hidden;
	}

	.hero-glow {
		position: absolute;
		inset: 0;
		pointer-events: none;
		background: radial-gradient(120% 140% at 100% 0%, rgba(255, 152, 31, 0.22), transparent 55%);
	}

	.hero-text {
		position: relative;
		min-width: 0;
	}

	.hero h1 {
		margin: 0 0 0.3rem;
		font-size: 2.4rem;
		line-height: 1;
		color: var(--accent);
		text-shadow: var(--ts);
		letter-spacing: 0.5px;
	}

	.hero-text p {
		margin: 0;
		max-width: 38rem;
		color: var(--muted);
		font-size: 0.95rem;
	}

	.vp {
		position: relative;
		display: flex;
		align-items: baseline;
		gap: 0.4rem;
		padding: 0.55rem 1.2rem;
		background: var(--accent-soft);
		border: 1px solid var(--accent);
		border-radius: 999px;
		text-shadow: var(--ts);
		flex: 0 0 auto;
		box-shadow: 0 0 1.2rem -0.3rem var(--accent);
	}

	.vp-amount {
		font-family: 'rsbold', ui-sans-serif, Arial, sans-serif;
		font-size: 1.6rem;
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

	/* ---- Store layout: packs + live-drops rail ---- */
	.store {
		display: grid;
		grid-template-columns: minmax(0, 1fr) 18rem;
		gap: 1.5rem;
		align-items: start;
	}

	.store.no-rail {
		grid-template-columns: 1fr;
	}

	/* min-width:0 lets these grid columns hold scrolling/overflowing content
	   (the pack grid, the drops strip) without blowing the page width out. */
	.main {
		min-width: 0;
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
		grid-template-columns: repeat(auto-fill, minmax(13rem, 1fr));
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
		transition: border-color 0.15s, transform 0.15s, box-shadow 0.15s;
	}

	.pack:hover {
		border-color: var(--accent);
		transform: translateY(-3px);
		box-shadow: 0 8px 20px -6px rgba(255, 152, 31, 0.4), var(--shadow-card);
	}

	.pack.dim {
		opacity: 0.6;
	}

	.pack.dim:hover {
		transform: none;
		border-color: var(--border);
		box-shadow: var(--shadow-card);
	}

	.pack-art {
		position: relative;
		width: 100%;
		aspect-ratio: 5 / 7;
		background: #0008;
		border-bottom: 1px solid var(--border);
	}

	.pack-art img {
		width: 100%;
		height: 100%;
		object-fit: cover;
		display: block;
	}

	.pack-tag {
		position: absolute;
		top: 0.5rem;
		left: 0.5rem;
		padding: 0.1rem 0.5rem;
		background: rgba(0, 0, 0, 0.7);
		border: 1px solid var(--accent);
		border-radius: 999px;
		font-size: 0.7rem;
		color: var(--accent);
		text-shadow: var(--ts);
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
		box-shadow: 0 0 0.8rem -0.2rem var(--accent);
	}

	button.primary:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	.warn {
		color: var(--danger);
		text-align: center;
	}

	.view-cards {
		align-self: flex-start;
		min-height: auto;
		padding: 0.3rem 0.7rem;
		font-size: 0.8rem;
	}

	/* ---- Pack-contents modal ---- */
	.contents-wrap {
		position: fixed;
		inset: 0;
		z-index: 100;
		display: grid;
		place-items: center;
		padding: 1rem;
	}

	.contents-backdrop {
		position: absolute;
		inset: 0;
		width: 100%;
		height: 100%;
		min-height: 0;
		padding: 0;
		border: none;
		border-radius: 0;
		background: rgba(0, 0, 0, 0.72);
		cursor: pointer;
	}

	.contents {
		position: relative;
		z-index: 1;
		width: min(52rem, 100%);
		max-height: 85vh;
		display: flex;
		flex-direction: column;
		background: linear-gradient(180deg, rgba(48, 40, 30, 0.98), rgba(30, 24, 18, 0.98));
		border: 1px solid var(--border-strong);
		border-radius: var(--radius-lg);
		box-shadow: var(--shadow-card);
		overflow: hidden;
	}

	.contents-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
		padding: 0.9rem 1.1rem;
		border-bottom: 1px solid var(--border);
	}

	.contents-head h3 {
		margin: 0;
		font-size: 1.1rem;
		color: var(--accent);
		text-shadow: var(--ts);
	}

	.contents-close {
		min-height: auto;
		padding: 0.2rem 0.6rem;
	}

	.contents-grid {
		padding: 1rem;
		overflow-y: auto;
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(9rem, 1fr));
		gap: 0.9rem;
		align-items: start; /* don't stretch tiles to equal height (it clips the name) */
	}

	/* Let full card names wrap here instead of being clipped (CardThumb defaults to
	   a single ellipsised line). overflow:visible on the thumb stops the wrapped
	   name being cut off; we re-round the art corners since the thumb no longer clips. */
	.contents-grid :global(.card-thumb) {
		overflow: visible;
	}

	.contents-grid :global(.art) {
		flex-shrink: 0; /* keep the aspect-ratio art from collapsing (esp. on mobile) */
		border-radius: var(--radius-lg) var(--radius-lg) 0 0;
		overflow: hidden;
	}

	.contents-grid :global(.name) {
		white-space: normal;
		overflow: visible;
		text-overflow: clip;
	}

	/* ---- Packs / Crates view tabs ---- */
	.view-tabs {
		display: inline-flex;
		gap: 0.25rem;
		margin-bottom: 1.25rem;
		padding: 0.25rem;
		background: var(--surface-alt);
		border: 1px solid var(--border);
		border-radius: 999px;
	}

	.view-tabs button {
		min-height: auto;
		padding: 0.4rem 1.1rem;
		border: none;
		border-radius: 999px;
		background: transparent;
		color: var(--muted);
		font-family: 'rsbold', ui-sans-serif, Arial, sans-serif;
	}

	.view-tabs button.active {
		background: var(--accent-soft);
		color: var(--accent);
		box-shadow: inset 0 0 0 1px var(--accent);
	}

	/* ---- Crate view ---- */
	.crate-wrap {
		max-width: 30rem;
		margin: 0 auto;
	}

	.crate {
		display: flex;
		gap: 1.1rem;
		align-items: center;
		padding: 1.25rem;
		background: linear-gradient(180deg, rgba(58, 48, 36, 0.85), rgba(40, 32, 24, 0.85));
		border: 1px solid var(--border);
		border-radius: var(--radius-lg);
		box-shadow: var(--shadow-card);
	}

	.crate-icon {
		flex: 0 0 auto;
		width: 5rem;
		height: 5rem;
		display: grid;
		place-items: center;
		font-size: 3rem;
		background: var(--accent-soft);
		border: 1px solid var(--accent);
		border-radius: var(--radius);
		box-shadow: 0 0 1rem -0.2rem var(--accent);
	}

	.crate-body {
		min-width: 0;
	}

	.crate-body h2 {
		margin: 0 0 0.2rem;
		color: var(--accent);
		text-shadow: var(--ts);
	}

	.crate-body p {
		margin: 0 0 0.75rem;
		font-size: 0.9rem;
	}

	.crate-actions {
		display: flex;
		gap: 0.5rem;
		flex-wrap: wrap;
	}

	.crate-actions form {
		flex: 1 1 8rem;
	}

	.crate-actions .primary {
		width: 100%;
	}

	.crate-body .small {
		display: block;
		margin-top: 0.5rem;
	}

	.odds {
		margin-top: 1rem;
		background: var(--surface-alt);
		border: 1px solid var(--border);
		border-radius: var(--radius);
		padding: 0.6rem 0.9rem;
	}

	.odds summary {
		cursor: pointer;
		color: var(--muted);
		font-size: 0.9rem;
	}

	.odds ul {
		list-style: none;
		margin: 0.6rem 0 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 0.3rem;
	}

	.odds li {
		display: flex;
		justify-content: space-between;
		font-size: 0.85rem;
	}

	.odds-label {
		font-family: 'rsbold', ui-sans-serif, Arial, sans-serif;
	}

	/* ---- Crate reveal modal ---- */
	.reveal-wrap {
		position: fixed;
		inset: 0;
		z-index: 100;
		display: grid;
		place-items: center;
		padding: 1rem;
	}

	.reveal-backdrop {
		position: absolute;
		inset: 0;
		width: 100%;
		height: 100%;
		min-height: 0;
		padding: 0;
		border: none;
		border-radius: 0;
		background: rgba(0, 0, 0, 0.72);
		cursor: pointer;
	}

	.reveal {
		position: relative;
		z-index: 1;
		width: min(22rem, 100%);
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 0.5rem;
		padding: 1.6rem 1.5rem;
		text-align: center;
		background: linear-gradient(180deg, rgba(48, 40, 30, 0.98), rgba(30, 24, 18, 0.98));
		border: 1px solid var(--c);
		border-radius: var(--radius-lg);
		box-shadow: 0 0 2.5rem -0.5rem var(--c);
		animation: reveal-pop 0.32s cubic-bezier(0.2, 1.3, 0.5, 1);
	}

	@keyframes reveal-pop {
		from {
			transform: scale(0.6);
			opacity: 0;
		}
		to {
			transform: scale(1);
			opacity: 1;
		}
	}

	.reveal-burst {
		position: absolute;
		top: 4.5rem;
		width: 12rem;
		height: 12rem;
		border-radius: 50%;
		background: radial-gradient(circle, color-mix(in srgb, var(--c) 55%, transparent), transparent 65%);
		pointer-events: none;
		animation: burst 0.6s ease-out forwards;
	}

	@keyframes burst {
		from {
			transform: scale(0.2);
			opacity: 0.9;
		}
		to {
			transform: scale(1.4);
			opacity: 0;
		}
	}

	.reveal-img {
		position: relative;
		width: 9rem;
		height: 9rem;
		object-fit: contain;
		filter: drop-shadow(0 0 0.8rem var(--c));
	}

	.reveal-title {
		margin: 0;
		color: var(--c);
		text-shadow: var(--ts);
	}

	.reveal-detail {
		margin: 0;
		font-family: 'rsbold', ui-sans-serif, Arial, sans-serif;
		font-size: 1.3rem;
	}

	.reveal-chance {
		font-size: 0.8rem;
		color: var(--muted);
	}

	.reveal-close {
		margin-top: 0.6rem;
		border-color: var(--accent);
	}

	/* ---- Live-drops rail ---- */
	.rail {
		position: sticky;
		top: 1rem;
		min-width: 0;
		background: linear-gradient(180deg, rgba(48, 40, 30, 0.7), rgba(34, 28, 22, 0.7));
		border: 1px solid var(--border);
		border-radius: var(--radius-lg);
		padding: 0.9rem;
	}

	.rail-title {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		margin: 0 0 0.85rem;
		font-size: 1.05rem;
		color: var(--accent);
		text-shadow: var(--ts);
	}

	.live {
		width: 0.55rem;
		height: 0.55rem;
		border-radius: 999px;
		background: #ff4d4d;
		box-shadow: 0 0 0.5rem #ff4d4d;
		animation: pulse 1.6s ease-in-out infinite;
	}

	@keyframes pulse {
		0%,
		100% {
			opacity: 1;
			transform: scale(1);
		}
		50% {
			opacity: 0.4;
			transform: scale(0.7);
		}
	}

	.rail-list {
		display: flex;
		flex-direction: column;
		gap: 0.55rem;
		max-height: calc(100vh - 9rem);
		overflow-y: auto;
	}

	.drop {
		display: flex;
		gap: 0.55rem;
		padding: 0.45rem;
		background: var(--surface-alt);
		border: 1px solid var(--rare-color);
		border-radius: var(--radius);
		box-shadow: 0 0 0.5rem -0.15rem var(--rare-color);
	}

	.drop-art {
		position: relative;
		flex: 0 0 3rem;
		align-self: center;
		line-height: 0;
	}

	/* The front image defines the box, so it sizes to the card's real proportions —
	   no fixed aspect-ratio means no letterbox bars and no cropping. */
	.drop-art .front {
		display: block;
		width: 100%;
		height: auto;
		border-radius: 3px;
	}

	/* Depth layers stacked over the front (flat composite) — matches the collection. */
	.drop-art .layer {
		position: absolute;
		inset: 0;
		width: 100%;
		height: 100%;
	}

	/* Fallback tile for a drop with no art (e.g. a plain VP win). */
	.drop-noimg {
		width: 100%;
		aspect-ratio: 1;
		display: grid;
		place-items: center;
		border-radius: 3px;
		background: color-mix(in srgb, var(--rare-color) 22%, #000a);
		color: var(--rare-color);
		font-family: 'rsbold', ui-sans-serif, Arial, sans-serif;
		font-size: 0.78rem;
	}

	.drop-info {
		display: flex;
		flex-direction: column;
		justify-content: center;
		gap: 0.05rem;
		min-width: 0;
		flex: 1;
	}

	.drop-name {
		font-size: 0.85rem;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.drop-rarity {
		font-size: 0.72rem;
		font-family: 'rsbold', ui-sans-serif, Arial, sans-serif;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.drop-sub {
		font-size: 0.7rem;
		color: var(--muted);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.drop-time {
		font-size: 0.68rem;
		color: var(--muted-soft, var(--muted));
	}

	/* ---- Mobile: stack, and move the live feed up as a horizontal strip of the
	   same compact rows (just scrolling sideways) ---- */
	@media (max-width: 860px) {
		.store {
			grid-template-columns: 1fr;
		}

		.rail {
			position: static;
			order: -1;
		}

		.rail-list {
			flex-direction: row;
			max-height: none;
			overflow-x: auto;
			overflow-y: visible;
			padding-bottom: 0.5rem;
			scroll-snap-type: x proximity;
		}

		.drop {
			flex: 0 0 14rem;
			scroll-snap-align: start;
		}
	}

	@media (max-width: 540px) {
		.hero {
			padding: 0.9rem 1rem;
			margin-bottom: 1rem;
		}

		.hero h1 {
			font-size: 1.5rem;
			margin-bottom: 0.15rem;
		}

		.hero-text p {
			font-size: 0.82rem;
		}

		.vp {
			padding: 0.4rem 0.9rem;
		}

		.vp-amount {
			font-size: 1.25rem;
		}

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
