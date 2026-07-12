<script lang="ts">
	import type { Snippet } from 'svelte';

	// Shared tab-body wrapper for the profile pages: consistent padding + the fade-in.
	// The `panel` class picks up the site-wide OSRS stone/gold framing from app.css's
	// `.page :is(.card, .panel, .stat)` rollout rule.
	let { children }: { children: Snippet } = $props();
</script>

<div class="panel">{@render children()}</div>

<style>
	.panel {
		padding: 1.1rem 1.25rem;
		animation: fade-in 0.2s ease-out;
	}

	@keyframes fade-in {
		from {
			opacity: 0;
			transform: translateY(4px);
		}
		to {
			opacity: 1;
			transform: none;
		}
	}
</style>
