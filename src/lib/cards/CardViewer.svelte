<script lang="ts">
	import { RARITY_BY_KEY, DEFAULT_RARITY, DEFAULT_CARD_BACK, type Card } from '$lib/cards/rarity';
	import { FINISH_BY_KEY, type CardFinish } from '$lib/cards/finishes';

	let {
		card,
		onClose
	}: {
		card: Card & { finish?: CardFinish; quantity?: number | null };
		onClose: () => void;
	} = $props();

	let flipped = $state(false);
	let sx = $state(50); // sheen x (%)
	let sy = $state(50); // sheen y (%)

	let rarity = $derived(RARITY_BY_KEY[card.rarity] ?? RARITY_BY_KEY[DEFAULT_RARITY]);
	let finish = $derived(card.finish ? FINISH_BY_KEY[card.finish] : null);
	let isHolo = $derived(!!finish && finish.key !== 'normal');
	let front = $derived(card.front_url || DEFAULT_CARD_BACK);
	let back = $derived(card.back_url || DEFAULT_CARD_BACK);

	function onMove(e: PointerEvent) {
		const el = e.currentTarget as HTMLElement;
		const r = el.getBoundingClientRect();
		sx = ((e.clientX - r.left) / r.width) * 100;
		sy = ((e.clientY - r.top) / r.height) * 100;
	}

	function onKey(e: KeyboardEvent) {
		if (e.key === 'Escape') onClose();
	}
</script>

<svelte:window onkeydown={onKey} />

<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
<div class="backdrop" onclick={onClose} role="presentation">
	<div
		class="viewer"
		role="dialog"
		aria-modal="true"
		aria-label={card.name}
		onclick={(e) => e.stopPropagation()}
		tabindex="-1"
	>
		<button class="close" onclick={onClose} aria-label="Close">×</button>

		<div class="stage">
			<button
				type="button"
				class="card-flip"
				class:flipped
				style="--rarity:{rarity.color}; --sx:{sx}%; --sy:{sy}%"
				onclick={() => (flipped = !flipped)}
				onpointermove={onMove}
				title="Click to flip"
			>
				<div class="face front">
					<img src={front} alt={card.name} />
					{#if isHolo}
						<span class="holo" class:prism={finish?.key === 'prism'}></span>
					{/if}
				</div>
				<div class="face back">
					<img src={back} alt="" />
				</div>
			</button>
		</div>

		<div class="meta">
			<div class="meta-head">
				<h2>{card.name}</h2>
				<span class="rarity" style="--rarity:{rarity.color}">
					{rarity.label}{#if card.level} · lvl {card.level}{/if}
				</span>
			</div>

			<div class="badges">
				{#if finish}
					<span class="badge" class:holo-badge={isHolo}>{finish.label}</span>
				{/if}
				{#if card.quantity && card.quantity > 0}
					<span class="badge owned">×{card.quantity} owned</span>
				{/if}
			</div>

			{#if card.abilities.length}
				<ul class="abilities">
					{#each card.abilities as ab}
						<li><strong>{ab.name}</strong>{#if ab.description} — {ab.description}{/if}</li>
					{/each}
				</ul>
			{/if}

			{#if card.flavor}
				<p class="flavor">"{card.flavor}"</p>
			{/if}

			<p class="hint">Click the card to flip it · Esc to close</p>
		</div>
	</div>
</div>

<style>
	.backdrop {
		position: fixed;
		inset: 0;
		z-index: 100;
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 1.5rem;
		background: rgba(0, 0, 0, 0.78);
		backdrop-filter: blur(4px);
		-webkit-backdrop-filter: blur(4px);
		animation: fade 0.15s ease-out;
	}

	@keyframes fade {
		from {
			opacity: 0;
		}
	}

	.viewer {
		position: relative;
		display: flex;
		gap: 1.5rem;
		max-width: 760px;
		width: 100%;
		padding: 1.5rem;
		background: linear-gradient(180deg, rgba(58, 48, 36, 0.96), rgba(32, 26, 20, 0.96));
		border: 1px solid var(--border);
		border-radius: var(--radius-lg);
		box-shadow: 0 16px 48px rgba(0, 0, 0, 0.6);
		outline: none;
	}

	.close {
		position: absolute;
		top: 0.5rem;
		right: 0.5rem;
		width: 2rem;
		height: 2rem;
		min-height: auto;
		padding: 0;
		display: flex;
		align-items: center;
		justify-content: center;
		font-size: 1.4rem;
		line-height: 1;
		background: transparent;
		border: 1px solid var(--border);
		border-radius: 999px;
		color: var(--muted);
		cursor: pointer;
	}

	.close:hover {
		color: var(--text);
		border-color: var(--border-strong);
	}

	.stage {
		flex: 0 0 auto;
		width: 16rem;
		max-width: 42vw;
		perspective: 1200px;
	}

	.card-flip {
		position: relative;
		display: block;
		width: 100%;
		aspect-ratio: 5 / 7;
		padding: 0;
		background: transparent;
		border: none;
		cursor: pointer;
		transform-style: preserve-3d;
		transition: transform 0.5s ease;
	}

	.card-flip.flipped {
		transform: rotateY(180deg);
	}

	.face {
		position: absolute;
		inset: 0;
		backface-visibility: hidden;
		-webkit-backface-visibility: hidden;
		border-radius: var(--radius);
		border: 1px solid var(--rarity);
		overflow: hidden;
		box-shadow: 0 0 18px -2px var(--rarity);
	}

	.face.back {
		transform: rotateY(180deg);
	}

	.face img {
		width: 100%;
		height: 100%;
		object-fit: cover;
		display: block;
	}

	/* Lightweight CSS holo sheen (the full 3D shader lives in the opener). */
	.holo {
		position: absolute;
		inset: 0;
		pointer-events: none;
		mix-blend-mode: color-dodge;
		opacity: 0.4;
		background:
			radial-gradient(
				circle at var(--sx) var(--sy),
				rgba(255, 255, 255, 0.5),
				transparent 45%
			),
			conic-gradient(
				from 0deg at var(--sx) var(--sy),
				#ff004c,
				#fffd00,
				#00ff8f,
				#00b3ff,
				#c400ff,
				#ff004c
			);
		background-blend-mode: screen;
	}

	.holo.prism {
		opacity: 0.55;
	}

	.meta {
		display: flex;
		flex-direction: column;
		gap: 0.6rem;
		min-width: 0;
		flex: 1;
	}

	.meta-head h2 {
		margin: 0 0 0.15rem;
		font-size: 1.5rem;
		line-height: 1.1;
	}

	.rarity {
		color: var(--rarity);
		font-size: 0.9rem;
	}

	.badges {
		display: flex;
		flex-wrap: wrap;
		gap: 0.4rem;
	}

	.badge {
		padding: 0.1rem 0.55rem;
		border-radius: 999px;
		border: 1px solid var(--border);
		background: var(--surface-alt);
		color: var(--muted);
		font-size: 0.75rem;
	}

	.badge.holo-badge {
		border-color: #b06bff;
		color: #d7b3ff;
		background: rgba(176, 107, 255, 0.12);
	}

	.badge.owned {
		color: var(--text);
	}

	.abilities {
		list-style: none;
		margin: 0.25rem 0 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 0.4rem;
	}

	.abilities li {
		font-size: 0.9rem;
		line-height: 1.35;
		padding: 0.4rem 0.6rem;
		background: var(--surface-alt);
		border: 1px solid var(--border);
		border-radius: var(--radius);
	}

	.abilities strong {
		color: var(--accent);
	}

	.flavor {
		margin: 0;
		font-style: italic;
		color: var(--muted);
		font-size: 0.9rem;
	}

	.hint {
		margin: auto 0 0;
		color: var(--muted);
		font-size: 0.78rem;
	}

	@media (max-width: 560px) {
		.viewer {
			flex-direction: column;
			align-items: center;
			overflow-y: auto;
			max-height: 90vh;
		}

		.stage {
			width: 12rem;
			max-width: 60vw;
		}

		.meta {
			width: 100%;
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.card-flip {
			transition: none;
		}
	}
</style>
