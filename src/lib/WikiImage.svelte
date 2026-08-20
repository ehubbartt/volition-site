<script lang="ts">
	// An <img> for OSRS Wiki images with the fiddly hotlink incantation baked in
	// (referrerpolicy=no-referrer + retry-then-hide), so components stop re-spelling it. Pair
	// with the URL builders in $lib/wikiImage. Renders nothing when `src` is empty.
	//
	// `src` takes EITHER a url or a list of candidate urls. The builders in $lib/wikiImage
	// return a list — the same item can be filed under more than one spelling on the wiki
	// (case is significant past the first letter) — and `retryImage` walks it before giving
	// up, so a title-cased file no longer renders as a blank tile.
	import { retryImage } from '$lib/imageRetry';
	let {
		src,
		alt = '',
		size = 42,
		class: klass = ''
	}: { src: string | string[]; alt?: string; size?: number; class?: string } = $props();

	const sources = $derived((Array.isArray(src) ? src : [src]).filter(Boolean));
	const first = $derived(sources[0] ?? '');
	// Identity of the whole candidate list, so {#key} remounts when any of it changes.
	const key = $derived(sources.join('|'));
</script>

{#if first}
	<!-- Key on the candidate list so a changed URL (e.g. rerolling a board) remounts a FRESH
	     <img>: the reused element would otherwise keep a prior src's hidden state, leaving
	     tiles blank until a hard refresh. `use:retryImage` tries each candidate spelling and
	     then re-fetches with backoff, so neither a wiki throttle nor a case mismatch latches
	     the tile blank. No lazy-loading — these icons are small/few and eager loading avoids
	     the intersection quirks that dynamically-swapped images run into. -->
	{#key key}
		<img
			class="wiki-img {klass}"
			src={first}
			{alt}
			width={size}
			height={size}
			decoding="async"
			referrerpolicy="no-referrer"
			use:retryImage={{ sources }}
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
