<script lang="ts">
	// Shared sub-navigation for the super-admin "Database" panel: the Bot Config editor
	// and the generic Table Editor. Each is its own route; the Table Editor also has
	// /admin/tables/[table] drill-down pages (kept active via startsWith).
	import { page } from '$app/stores';

	type TabDef = { label: string; href: string; prefix: string };

	const TABS: TabDef[] = [
		{ label: 'Bot Config', href: '/admin/config', prefix: '/admin/config' },
		{ label: 'Table Editor', href: '/admin/tables', prefix: '/admin/tables' },
		{ label: 'Player Inventory', href: '/admin/inventory', prefix: '/admin/inventory' }
	];

	let path = $derived($page.url.pathname);
	const isActive = (t: TabDef) => path === t.prefix || path.startsWith(t.prefix + '/');
</script>

<h1 class="panel-title">Database</h1>
<nav class="tabs">
	{#each TABS as t (t.href)}
		<a class="tab" class:active={isActive(t)} href={t.href}>{t.label}</a>
	{/each}
</nav>

<style>
	.panel-title {
		margin: 0 0 0.75rem;
	}
	.tabs {
		display: flex;
		flex-wrap: wrap;
		gap: 0.25rem;
		margin-bottom: 1.25rem;
		border-bottom: 1px solid var(--border);
	}
	.tab {
		display: inline-flex;
		align-items: center;
		gap: 0.4rem;
		padding: 0.55rem 1rem;
		border-bottom: 2px solid transparent;
		color: var(--muted);
		font-size: 1rem;
		text-decoration: none;
		transition: color 0.15s, border-color 0.15s;
	}
	.tab:hover {
		color: var(--text);
		text-decoration: none;
	}
	.tab.active {
		color: var(--accent);
		border-bottom-color: var(--accent);
	}
</style>
