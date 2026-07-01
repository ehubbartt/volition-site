<script lang="ts">
	import WikiImage from '$lib/WikiImage.svelte';

	// A reusable board tile for bingo / event / personal-board grids: the site's bronze OSRS
	// button frame over a tan fill, an icon on a light parchment disc (so even dark/black wiki
	// glyphs stay visible), a clamped name, and an optional sub-line. Completion shows as a
	// green inner ring; `highlighted` adds the accent glow used for completed bingo lines. Drop
	// it into a CSS grid — it renders a single grid item.
	let {
		image = null,
		imageAlt = '',
		name,
		sub = '',
		obtained = false,
		highlighted = false,
		title = '',
		imageSize = 42
	}: {
		image?: string | null;
		imageAlt?: string;
		name: string;
		sub?: string;
		obtained?: boolean;
		highlighted?: boolean;
		title?: string;
		imageSize?: number;
	} = $props();
</script>

<div class="tile" class:obtained class:highlighted {title}>
	<div class="icon">
		{#if image}
			<WikiImage src={image} alt={imageAlt} size={imageSize} />
		{/if}
	</div>
	<div class="name">{name}</div>
	{#if sub}
		<div class="sub">{sub}</div>
	{/if}
</div>

<style>
	/* Tiles wear the same bronze OSRS button frame + tan fill as the site's buttons. */
	.tile {
		position: relative;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: flex-start;
		gap: 0.3rem;
		padding: 0.55rem 0.4rem;
		min-height: 7rem;
		text-align: center;
		background: #4d4336;
		border: 9px solid transparent;
		border-image: url('/osrs/button.png') 9 / 9px stretch;
		border-radius: 5px;
	}
	/* Completed: a green inner ring + faint green wash. The frame is unchanged so a tile never
	   resizes when it ticks off. */
	.tile.obtained {
		background: #3b4a2c;
		box-shadow: inset 0 0 0 3px var(--success);
	}
	.tile.highlighted {
		box-shadow: 0 0 0 2px var(--accent), 0 0 14px -2px var(--accent);
	}
	.tile.obtained.highlighted {
		box-shadow:
			inset 0 0 0 3px var(--success),
			0 0 0 2px var(--accent),
			0 0 14px -2px var(--accent);
	}
	/* Every icon sits on a light parchment disc, wide enough that a square ~40-42px icon's
	   corners clear the circle (needs ≥ side·√2). */
	.icon {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 64px;
		height: 64px;
		border-radius: 50%;
		background: radial-gradient(circle at 50% 38%, #f1e8cf, #c3b088);
		box-shadow:
			inset 0 0 0 2px rgba(0, 0, 0, 0.45),
			inset 0 -3px 6px rgba(0, 0, 0, 0.18);
	}
	.name {
		font-size: 0.78rem;
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
		font-size: 0.72rem;
		color: #cbb78b;
		font-family: var(--font-heading);
	}
	.tile.obtained .name,
	.tile.obtained .sub {
		opacity: 0.6;
	}
</style>
