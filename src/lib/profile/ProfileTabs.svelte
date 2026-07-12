<script lang="ts">
	// Shared underline tab strip for the profile pages. Pass counts to show the
	// little chip next to a label (collection size, wallet items…).
	interface TabDef {
		id: string;
		label: string;
		count?: number | null;
	}

	let {
		tabs,
		active,
		onselect
	}: { tabs: TabDef[]; active: string; onselect: (id: string) => void } = $props();
</script>

<nav class="tabs">
	{#each tabs as t (t.id)}
		<button type="button" class="tab" class:active={active === t.id} onclick={() => onselect(t.id)}>
			{t.label}
			{#if t.count}<span class="count">{t.count}</span>{/if}
		</button>
	{/each}
</nav>

<style>
	.tabs {
		display: flex;
		gap: 0.25rem;
		margin: 1.25rem 0 1rem;
		border-bottom: 1px solid var(--border);
	}

	.tab {
		display: inline-flex;
		align-items: center;
		gap: 0.4rem;
		min-height: auto;
		padding: 0.55rem 1rem;
		background: transparent;
		border: none;
		border-bottom: 2px solid transparent;
		border-radius: 0;
		color: var(--muted);
		font-size: 1rem;
		cursor: pointer;
		transition:
			color 0.15s,
			border-color 0.15s;
	}

	.tab:hover {
		color: var(--text);
		background: transparent;
	}

	.tab.active {
		color: var(--accent);
		border-bottom-color: var(--accent);
	}

	.count {
		padding: 0.05rem 0.45rem;
		background: var(--surface-alt);
		border: 1px solid var(--border);
		border-radius: 3px;
		font-size: 0.75rem;
		color: var(--text);
	}
</style>
