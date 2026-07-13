<script lang="ts">
	import WikiImage from '$lib/WikiImage.svelte';

	// A reusable board tile for bingo / event / personal-board grids: the site's bronze OSRS
	// button frame over a tan fill, an icon on a light parchment disc (so even dark/black wiki
	// glyphs stay visible), a clamped name, and an optional sub-line. Completion shows as a
	// soft green wash + a gold-rimmed check medallion on the corner; `highlighted` adds the
	// accent glow used for completed bingo lines. Drop it into a CSS grid — it renders a
	// single grid item.
	let {
		image = null,
		imageAlt = '',
		name,
		sub = '',
		obtained = false,
		highlighted = false,
		title = '',
		imageSize = 42,
		onselect,
		ontileclick
	}: {
		image?: string | null;
		imageAlt?: string;
		name: string;
		sub?: string;
		obtained?: boolean;
		highlighted?: boolean;
		title?: string;
		imageSize?: number;
		/** When provided, the icon disc becomes a button that calls this on click. */
		onselect?: () => void;
		/** When provided, the WHOLE tile is clickable (icon clicks still fire onselect only). */
		ontileclick?: () => void;
	} = $props();
</script>

<!-- svelte-ignore a11y_no_noninteractive_tabindex -- tabindex and role="button" are set
     together (only when ontileclick makes the tile interactive); the analyzer can't see
     the conditions match. -->
<div
	class="tile"
	class:obtained
	class:highlighted
	class:clickable={!!ontileclick}
	{title}
	role={ontileclick ? 'button' : undefined}
	tabindex={ontileclick ? 0 : undefined}
	onclick={ontileclick}
	onkeydown={ontileclick
		? (e) => {
				if (e.key === 'Enter' || e.key === ' ') {
					e.preventDefault();
					ontileclick();
				}
			}
		: undefined}
>
	{#if onselect}
		<button
			type="button"
			class="icon"
			onclick={(e) => {
				e.stopPropagation();
				onselect();
			}}
			aria-label={`${name} — details`}
		>
			{#if image}
				<WikiImage src={image} alt={imageAlt} size={imageSize} />
			{/if}
		</button>
	{:else}
		<div class="icon">
			{#if image}
				<WikiImage src={image} alt={imageAlt} size={imageSize} />
			{/if}
		</div>
	{/if}
	<div class="name">{name}</div>
	{#if sub}
		<div class="sub">{sub}</div>
	{/if}
</div>

<style>
	/* Tiles wear the same bronze OSRS button frame + tan fill as the site's buttons. The tile is
	   a size container (container-type: inline-size) so the disc + text scale with the tile's
	   own width — the board then shrinks to fit narrow phones instead of overflowing the page. */
	.tile {
		container-type: inline-size;
		position: relative;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: flex-start;
		gap: 0.3rem;
		min-width: 0;
		padding: 0.55rem 0.4rem;
		min-height: 7rem;
		text-align: center;
		background: #4d4336;
		border: 9px solid transparent;
		border-image: url('/osrs/button.png') 9 / 9px stretch;
		border-radius: 5px;
	}
	/* Completed: a soft green wash breathing out from the edges (no hard inner rectangle)
	   plus a gold-rimmed check medallion on the corner. The frame is unchanged so a tile
	   never resizes when it ticks off. */
	.tile.obtained {
		background: linear-gradient(165deg, #445138 0%, #37432d 100%);
		box-shadow: inset 0 0 26px -4px rgba(120, 190, 90, 0.45);
	}
	.tile.obtained::after {
		content: '✓';
		position: absolute;
		top: -10px;
		right: -10px;
		width: 24px;
		height: 24px;
		display: flex;
		align-items: center;
		justify-content: center;
		border-radius: 50%;
		background: radial-gradient(circle at 35% 30%, #8fce6a, #4c7a2f 75%);
		color: #f7f3e4;
		font-size: 0.85rem;
		font-weight: 700;
		line-height: 1;
		box-shadow:
			inset 0 0 0 1.5px rgba(24, 42, 12, 0.65),
			0 0 0 2px #8a6d3b,
			0 2px 5px rgba(0, 0, 0, 0.55);
		pointer-events: none;
	}
	/* The icon settles back once done — the medallion carries the signal. */
	.tile.obtained .icon {
		filter: saturate(0.6) brightness(0.88);
	}
	/* Whole-tile click affordance (ontileclick). */
	.tile.clickable {
		cursor: pointer;
		transition: filter 0.1s ease;
	}
	.tile.clickable:hover {
		filter: brightness(1.07);
	}
	.tile.clickable:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 2px;
	}
	.tile.highlighted {
		box-shadow: 0 0 0 2px var(--accent), 0 0 14px -2px var(--accent);
	}
	.tile.obtained.highlighted {
		box-shadow:
			inset 0 0 26px -4px rgba(120, 190, 90, 0.45),
			0 0 0 2px var(--accent),
			0 0 14px -2px var(--accent);
	}
	/* Every icon sits on a light parchment disc. Its size scales with the tile width (60cqw),
	   capped at 64px, so on a narrow phone the disc shrinks with the tile instead of forcing the
	   board wider than the screen. The disc stays wide enough that a square icon's corners clear
	   the circle (needs ≥ side·√2). */
	.icon {
		display: flex;
		align-items: center;
		justify-content: center;
		width: clamp(34px, 60cqw, 64px);
		height: clamp(34px, 60cqw, 64px);
		border-radius: 50%;
		background: radial-gradient(circle at 50% 38%, #f1e8cf, #c3b088);
		box-shadow:
			inset 0 0 0 2px rgba(0, 0, 0, 0.45),
			inset 0 -3px 6px rgba(0, 0, 0, 0.18);
		/* Resets for when .icon is a <button> (overrides the global bronze button styling). */
		border: none;
		min-height: 0;
		padding: 0;
	}
	button.icon {
		cursor: pointer;
		transition: filter 0.1s ease;
	}
	button.icon:hover {
		filter: brightness(1.08);
	}
	button.icon:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 2px;
	}
	/* The wiki image fits inside the disc regardless of the disc's (responsive) size. Use a
	   DEFINITE size (66% of the disc) rather than width:auto — a lazy-loaded <img> with an
	   indefinite size can collapse to 0×0 and then never enters the viewport to load. object-fit
	   keeps the aspect ratio within that square. */
	.icon :global(.wiki-img) {
		width: 66%;
		height: 66%;
		object-fit: contain;
	}
	.name {
		font-size: clamp(0.62rem, 13cqw, 0.78rem);
		line-height: 1.1;
		color: var(--accent);
		overflow-wrap: anywhere;
		/* Clamp to 2 lines so a long name can't make one tile taller than the rest. */
		display: -webkit-box;
		-webkit-box-orient: vertical;
		-webkit-line-clamp: 2;
		line-clamp: 2;
		overflow: hidden;
	}
	.sub {
		font-size: clamp(0.58rem, 12cqw, 0.72rem);
		color: #cbb78b;
		font-family: var(--font-heading);
	}
	.tile.obtained .name,
	.tile.obtained .sub {
		opacity: 0.6;
	}
</style>
