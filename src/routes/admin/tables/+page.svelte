<script lang="ts">
	import type { PageData } from './$types';
	import DatabaseTabs from '$lib/admin/DatabaseTabs.svelte';

	let { data }: { data: PageData } = $props();
	let filter = $state('');

	let site = $derived(data.site.filter((t) => t.toLowerCase().includes(filter.trim().toLowerCase())));
	let other = $derived(data.other.filter((t) => t.toLowerCase().includes(filter.trim().toLowerCase())));
</script>

<svelte:head>
	<title>Table Editor · Volition Admin</title>
</svelte:head>

<section>
	<DatabaseTabs />
	<p class="muted warn-text">
		⚠ Direct database access. Edits here write straight to the shared database (site + bot). There is
		no undo — be careful.
	</p>

	<input class="search" type="search" placeholder="Filter tables…" bind:value={filter} />

	{#if other.length > 0}
		<h2>Bot tables</h2>
		<div class="grid">
			{#each other as t (t)}
				<a class="tile" href="/admin/tables/{t}">{t}</a>
			{/each}
		</div>
	{/if}

	{#if site.length > 0}
		<h2>Site tables (vs_*)</h2>
		<div class="grid">
			{#each site as t (t)}
				<a class="tile" href="/admin/tables/{t}">{t}</a>
			{/each}
		</div>
	{/if}

	{#if data.tables.length === 0}
		<p class="muted">No tables found.</p>
	{/if}
</section>

<style>
	h2 {
		margin: 1.5rem 0 0.75rem;
		font-size: 1rem;
		color: var(--accent);
		text-shadow: var(--ts);
	}
	.muted {
		color: var(--muted);
	}
	.warn-text {
		color: var(--accent);
	}
	.search {
		width: 100%;
		max-width: 24rem;
		margin-top: 0.75rem;
		padding: 0.5rem 0.7rem;
		background: var(--surface-alt);
		border: 1px solid var(--border);
		border-radius: var(--radius);
		color: var(--text);
		font-family: var(--font-body);
	}
	.search:focus {
		outline: none;
		border-color: var(--accent);
	}
	.grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(13rem, 1fr));
		gap: 0.6rem;
	}
	.tile {
		display: block;
		padding: 0.7rem 0.9rem;
		background: var(--surface);
		border: 1px solid var(--border);
		border-radius: var(--radius);
		color: var(--text);
		text-decoration: none;
		font-family: ui-monospace, 'SF Mono', Menlo, monospace;
		font-size: 0.85rem;
		transition: border-color 0.15s, transform 0.15s;
	}
	.tile:hover {
		border-color: var(--accent);
		color: var(--accent);
		transform: translateY(-1px);
		text-decoration: none;
	}
</style>
