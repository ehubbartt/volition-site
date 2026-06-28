<script lang="ts">
	// Shared sub-navigation for the Dink tracking admin panel: Simulator + Drops log.
	// Each is its own route (its own load); this bar makes them read as one panel,
	// mirroring the Clan Stats panel (StatsTabs).
	import { page } from '$app/stores';

	type TabDef = { label: string; href: string };

	const TABS: TabDef[] = [
		{ label: 'Simulator', href: '/admin/dink-test' },
		{ label: 'Drops log', href: '/admin/dink-drops' }
	];

	let path = $derived($page.url.pathname);
</script>

<a class="back" href="/admin">← Admin</a>
<h1 class="panel-title">Dink Tracking</h1>
<nav class="tabs">
	{#each TABS as t (t.href)}
		<a class="tab" class:active={path === t.href} href={t.href}>{t.label}</a>
	{/each}
</nav>

<style>
	.back {
		color: var(--accent);
		text-decoration: none;
		font-size: 0.9rem;
	}
	.panel-title {
		margin: 0.3rem 0 0.75rem;
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
