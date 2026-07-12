<script lang="ts">
	// Shared centered empty-state for the profile tab bodies.
	let { title, hint = null }: { title: string; hint?: string | null } = $props();
</script>

<div class="empty">
	<p>{title}</p>
	{#if hint}<p class="muted">{hint}</p>{/if}
</div>

<style>
	.empty {
		padding: 3rem 1rem;
		text-align: center;
	}

	.empty p {
		margin: 0.25rem 0;
	}

	.muted {
		color: var(--muted);
	}
</style>
