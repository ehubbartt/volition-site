<script lang="ts">
	// Shared sub-navigation for the "Clan Stats" admin panel: Overview + Wallets + Voice.
	// Each is its own route (its own load); this bar makes them read as one panel.
	import { page } from '$app/stores';

	type TabDef = { label: string; href: string };

	const TABS: TabDef[] = [
		{ label: 'Overview', href: '/admin/stats' },
		{ label: 'Wallets', href: '/admin/wallets' },
		{ label: 'Voice', href: '/admin/voice' }
	];

	let path = $derived($page.url.pathname);
</script>

<h1 class="panel-title">Clan Stats</h1>
<nav class="tabs">
	{#each TABS as t (t.href)}
		<a class="tab" class:active={path === t.href} href={t.href}>{t.label}</a>
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
