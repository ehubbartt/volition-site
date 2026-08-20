<script lang="ts">
	import WikiImage from '$lib/WikiImage.svelte';
	import { itemIconUrl } from '$lib/osrsItems';

	// OSRS Wiki item icon for wallet/loot lists. Delegates to <WikiImage> so it gets the
	// candidate-spelling walk and the throttle retry — it used to hide itself on the first
	// error, which meant every title-cased file name (and every throttled request) left a
	// gap in the list.
	let { item, size = 20 }: { item: string; size?: number } = $props();
</script>

<WikiImage src={itemIconUrl(item)} size={size} class="item-icon" />

<style>
	:global(img.item-icon) {
		object-fit: contain;
		vertical-align: middle;
	}
</style>
