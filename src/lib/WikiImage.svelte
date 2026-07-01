<script lang="ts">
	// An <img> for OSRS Wiki images with the fiddly hotlink incantation baked in
	// (referrerpolicy=no-referrer + hide-on-404), so components stop re-spelling it. Pair with
	// the URL builders in $lib/wikiImage. Renders nothing when `src` is empty.
	let {
		src,
		alt = '',
		size = 42,
		class: klass = ''
	}: { src: string; alt?: string; size?: number; class?: string } = $props();
</script>

{#if src}
	<img
		class="wiki-img {klass}"
		{src}
		{alt}
		width={size}
		height={size}
		loading="lazy"
		decoding="async"
		referrerpolicy="no-referrer"
		onerror={(e) => ((e.currentTarget as HTMLImageElement).style.display = 'none')}
	/>
{/if}

<style>
	.wiki-img {
		object-fit: contain;
		vertical-align: middle;
		image-rendering: -webkit-optimize-contrast;
	}
</style>
