<script lang="ts">
	import { itemIconUrl } from '$lib/osrsItems';

	// OSRS Wiki item icon with the fiddly hotlink incantation (referrerpolicy +
	// onerror-hide) baked in, so wallet/loot lists stop re-spelling it. Hides itself
	// on a 404 rather than showing a broken-image glyph.
	let { item, size = 20 }: { item: string; size?: number } = $props();
</script>

<img
	class="item-icon"
	src={itemIconUrl(item)}
	alt=""
	width={size}
	height={size}
	loading="lazy"
	referrerpolicy="no-referrer"
	onerror={(e) => ((e.currentTarget as HTMLImageElement).style.display = 'none')}
/>

<style>
	.item-icon {
		object-fit: contain;
		vertical-align: middle;
		image-rendering: -webkit-optimize-contrast;
	}
</style>
