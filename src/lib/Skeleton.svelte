<script lang="ts">
	// Shimmering placeholder block shown while a streamed section of page data is
	// still loading (see the promise-resolving pattern in +page.svelte). Size it with
	// the props; stack several for list/table skeletons.
	let {
		height = '1rem',
		width = '100%',
		radius = '4px'
	}: { height?: string; width?: string; radius?: string } = $props();
</script>

<div class="skeleton" style="height:{height};width:{width};border-radius:{radius}" aria-hidden="true"></div>

<style>
	.skeleton {
		background: linear-gradient(
			90deg,
			rgba(217, 182, 94, 0.08) 25%,
			rgba(217, 182, 94, 0.18) 50%,
			rgba(217, 182, 94, 0.08) 75%
		);
		background-size: 200% 100%;
		animation: skeleton-shimmer 1.4s ease-in-out infinite;
	}

	@keyframes skeleton-shimmer {
		from {
			background-position: 200% 0;
		}
		to {
			background-position: -200% 0;
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.skeleton {
			animation: none;
		}
	}
</style>
