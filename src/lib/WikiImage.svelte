<script lang="ts">
	// An <img> for OSRS Wiki images with the fiddly hotlink incantation baked in
	// (referrerpolicy=no-referrer + retry-then-hide), so components stop re-spelling it. Pair
	// with the URL builders in $lib/wikiImage. Renders nothing when `src` is empty.
	import { retryImage } from '$lib/imageRetry';
	let {
		src,
		alt = '',
		size = 42,
		class: klass = ''
	}: { src: string; alt?: string; size?: number; class?: string } = $props();
</script>

{#if src}
	<!-- Key on src so a changed URL (e.g. rerolling a board) remounts a FRESH <img>: the reused
	     element would otherwise keep a prior src's hidden state, leaving tiles blank until a hard
	     refresh. `use:retryImage` re-fetches a transiently-failed hotlink a few times before
	     hiding, so a wiki throttle no longer latches the tile blank until a manual refresh. No
	     lazy-loading — these icons are small/few and eager loading avoids the intersection quirks
	     that dynamically-swapped images run into. -->
	{#key src}
		<img
			class="wiki-img {klass}"
			{src}
			{alt}
			width={size}
			height={size}
			decoding="async"
			referrerpolicy="no-referrer"
			use:retryImage
		/>
	{/key}
{/if}

<style>
	.wiki-img {
		object-fit: contain;
		vertical-align: middle;
		image-rendering: -webkit-optimize-contrast;
	}
</style>
