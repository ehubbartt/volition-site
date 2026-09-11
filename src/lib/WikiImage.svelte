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
	import { viaProxy } from '$lib/wikiImage';
	let {
		src,
		alt = '',
		size = 42,
		class: klass = '',
		fallback = ''
	}: {
		src: string | string[];
		alt?: string;
		size?: number;
		class?: string;
		/** Shown in the image's place when no spelling resolves — see `retryImage`. */
		fallback?: string;
	} = $props();
	let failed = $state(false);

	// OUR ORIGIN ONLY. The wiki urls used to sit behind the proxy as a fallback, and that
	// was worse than having none: a browser that fell through to them was hotlinking again,
	// and a throttled wiki does not refuse those requests, it leaves them HANGING — an
	// <img> that never errors never reaches the fallback below, so the tile stayed blank
	// for good. The proxy already tries every spelling server-side, so there is nothing the
	// direct urls could still resolve; when it says no, the name has no file and the
	// fallback is the honest answer.
	const given = $derived((Array.isArray(src) ? src : [src]).filter(Boolean));
	const sources = $derived([...new Set(given.map(viaProxy))]);
	const first = $derived(sources[0] ?? '');
	// Identity of the whole candidate list, so {#key} remounts when any of it changes.
	const key = $derived(sources.join('|'));
	// A new candidate list is a fresh chance — clear the failure with it.
	$effect(() => {
		key;
		failed = false;
	});
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
			use:retryImage={{ sources, onfail: () => (failed = true) }}
		/>
		{#if failed && fallback}
			<span class="wiki-fallback" style="--s: {size}px" title={alt || fallback}>{fallback}</span>
		{/if}
	{/key}
{/if}

<style>
	/* Not every tile on a board is a real item — "Any Barrows Helm", "Rooftop Course Laps"
	   — and those have no wiki file to find. They read as themselves rather than as a gap. */
	.wiki-fallback {
		display: inline-grid;
		place-items: center;
		width: var(--s);
		height: var(--s);
		border-radius: 50%;
		background: color-mix(in srgb, var(--accent, #c8a24a) 22%, transparent);
		color: var(--text, #e8e3d5);
		font-size: calc(var(--s) * 0.42);
		font-weight: 700;
		line-height: 1;
		letter-spacing: -0.02em;
		vertical-align: middle;
	}
	.wiki-img {
		object-fit: contain;
		vertical-align: middle;
		image-rendering: -webkit-optimize-contrast;
	}
</style>
